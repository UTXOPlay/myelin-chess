use crate::game::{Game, ID, MAX_ACTIONS};
use myelin_consensus::{Authority, CommitteeSigner, ConsensusConfig, ProofOfAuthorityConfig};
use myelin_session::*;
use myelin_session_authority::{AuthorityConfig, AuthorityKeys, AuthoritySigner, SessionAuthority};
use myelin_session_journal::{application::*, *};
use myelin_session_runtime::RegisteredFinalityVerifier;
use myelin_session_store_rocksdb::RocksSessionStore;
use secp256k1::{Keypair, Message, Secp256k1, SecretKey, XOnlyPublicKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};

pub type AnyResult<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
fn hash(bytes: &[u8]) -> Hash32 {
    *blake3::hash(bytes).as_bytes()
}
fn random() -> AnyResult<Hash32> {
    let mut value = [0; 32];
    getrandom::getrandom(&mut value).map_err(|e| e.to_string())?;
    Ok(value)
}
fn parse_id(value: &str) -> AnyResult<Hash32> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err("Expected a canonical 32-byte lowercase hexadecimal identity".into());
    }
    Ok(hex::decode(value)?
        .try_into()
        .map_err(|_| "Invalid identity")?)
}
fn validate_room(value: &str) -> std::result::Result<(), String> {
    if value.len() != 24
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Invalid room identity".into());
    }
    Ok(())
}
fn atomic(path: &Path, bytes: &[u8]) -> AnyResult<()> {
    let parent = path.parent().ok_or("Missing parent")?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist(path)?;
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}
#[cfg(test)]
fn creation_fault(point: &str) {
    if std::env::var("CHESS_CREATION_FAULT").as_deref() == Ok(point) {
        std::process::exit(86);
    }
}
fn artifact() -> AnyResult<Hash32> {
    static DIGEST: OnceLock<Hash32> = OnceLock::new();
    if let Some(value) = DIGEST.get() {
        return Ok(*value);
    }
    let mut file = fs::File::open(std::env::current_exe()?)?;
    let mut digest = blake3::Hasher::new();
    let mut buf = [0; 65536];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        digest.update(&buf[..n]);
    }
    Ok(*DIGEST.get_or_init(|| *digest.finalize().as_bytes()))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Actor {
    pub account: String,
    pub seat: String,
}
impl Actor {
    pub fn validate(&self) -> AnyResult<()> {
        parse_id(&self.account)?;
        if !matches!(self.seat.as_str(), "solo" | "white" | "black") {
            return Err("Invalid seat".into());
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    action: Value,
    expected_cursor: u64,
    expected_block: String,
    actor: Actor,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    command_id: String,
    session_id: String,
    profile: String,
    action: Value,
    expected_cursor: u64,
    expected_block: String,
}

// The authenticated gateway attests account/seat admission. This signature is
// explicitly not a personal wallet signature. Original bytes survive retries.
struct Auth(XOnlyPublicKey);
impl CommandAuthenticator for Auth {
    fn verify(&self, command: &OriginalCommand) -> std::result::Result<(), String> {
        let intent: Intent =
            serde_json::from_slice(&command.canonical_command).map_err(|e| e.to_string())?;
        intent.actor.validate().map_err(|e| e.to_string())?;
        parse_id(&intent.expected_block).map_err(|e| e.to_string())?;
        if command.kind != InputKind::UserCommand
            || command.authentication_context != self.0.serialize()
            || command.identity.payload_hash != hash(&command.canonical_command)
            || serde_json::to_vec(&intent).map_err(|e| e.to_string())? != command.canonical_command
        {
            return Err("Invalid canonical gateway command".into());
        }
        let signature = secp256k1::schnorr::Signature::from_slice(&command.authorization)
            .map_err(|e| e.to_string())?;
        Secp256k1::verification_only()
            .verify_schnorr(
                &signature,
                &Message::from_digest(command.authorization_digest()),
                &self.0,
            )
            .map_err(|e| e.to_string())
    }
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Program {
    game: Game,
    solo: Option<String>,
    seats: [Option<String>; 2],
    room: Option<String>,
    next_session: Option<Hash32>,
}
impl Program {
    fn restore(bytes: &[u8]) -> std::result::Result<Self, String> {
        let value: Self = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
        value.game.validate()?;
        if value.game.view()["moves"]
            .as_array()
            .ok_or("Missing moves")?
            .len()
            > MAX_ACTIONS as usize
        {
            return Err("Snapshot action limit".into());
        }
        if value.room.is_some() != value.seats.iter().any(Option::is_some) {
            return Err("Room must have an explicitly admitted creator".into());
        }
        if let Some(id) = &value.room {
            validate_room(id)?;
        }
        if value.solo.is_some() && value.room.is_some() {
            return Err("Mixed solo/room admission".into());
        }
        for actor in value.solo.iter().chain(value.seats.iter().flatten()) {
            parse_id(actor).map_err(|e| e.to_string())?;
        }
        if value.seats[0].is_some() && value.seats[0] == value.seats[1] {
            return Err("One actor cannot occupy both room seats".into());
        }
        Ok(value)
    }
    fn act(
        &mut self,
        context: CommandContext,
        intent: &Intent,
        command: &OriginalCommand,
    ) -> std::result::Result<(), String> {
        let new_game = intent.action == json!({"type":"new_game"});
        if self.next_session.is_some() {
            return Err("Session is closed; inspect the original new-game command".into());
        }
        if intent.expected_cursor != context.input_position
            || context.input_position > MAX_ACTIONS
            || (!new_game && context.input_position == MAX_ACTIONS)
        {
            return Err("Stale command cursor or action limit".into());
        }
        let actor = &intent.actor;
        if new_game && actor.seat != "solo" {
            return Err("Online tables cannot start a solo session".into());
        }
        let admission = matches!(
            intent.action["type"].as_str(),
            Some("create_room" | "join_room")
        );
        if admission {
            if actor.seat == "solo" || self.solo.is_some() {
                return Err("Room admission requires an authenticated room seat".into());
            }
            let id = intent.action["room_id"]
                .as_str()
                .ok_or("Missing room identity")?;
            validate_room(id)?;
            let operation = intent.action["type"]
                .as_str()
                .ok_or("Missing admission operation")?;
            if intent.action != json!({"type":operation,"room_id":id,"color":actor.seat}) {
                return Err("Admission intent differs from authenticated seat".into());
            }
            let index = usize::from(actor.seat == "black");
            if operation == "create_room" {
                if context.input_position != 0 || self.room.is_some() {
                    return Err("Room creation requires the exact empty session".into());
                }
                self.room = Some(id.into());
            } else if self.room.as_deref() != Some(id) {
                return Err("Join intent belongs to another room".into());
            }
            if self.seats[index].is_some() || self.seats[1 - index].as_ref() == Some(&actor.account)
            {
                return Err("Seat is already admitted; recover the original command".into());
            }
            self.seats[index] = Some(actor.account.clone());
            return Ok(());
        }
        if actor.seat == "solo" {
            if self.room.is_some() || self.solo.as_ref().is_some_and(|id| id != &actor.account) {
                return Err("Wrong solo actor".into());
            }
            self.solo = Some(actor.account.clone());
        } else {
            let index = usize::from(actor.seat == "black");
            if self.solo.is_some()
                || self.room.is_none()
                || self.seats.iter().any(Option::is_none)
                || self.seats[index].as_ref() != Some(&actor.account)
                || self.game.view()["turn"] != actor.seat
            {
                return Err("Room move requires both admitted actors and the correct turn".into());
            }
        }
        if new_game {
            self.next_session = Some(hash(
                &[
                    b"chess-new-session-v1".as_slice(),
                    &command.authorization_digest(),
                ]
                .concat(),
            ));
            Ok(())
        } else {
            self.game.apply(&intent.action)
        }
    }
}
impl CommandProgram for Program {
    fn clock(&self) -> ApplicationClock {
        ApplicationClock::CommandSteps
    }
    fn snapshot(&self) -> std::result::Result<Vec<u8>, String> {
        serde_json::to_vec(self).map_err(|e| e.to_string())
    }
    fn apply(
        &mut self,
        context: CommandContext,
        command: &OriginalCommand,
    ) -> std::result::Result<BusinessOutcome, String> {
        let intent: Intent =
            serde_json::from_slice(&command.canonical_command).map_err(|e| e.to_string())?;
        Ok(match self.act(context, &intent, command) {
            Ok(()) => BusinessOutcome::Succeeded(
                serde_json::to_vec(&match self.next_session {
                    Some(id) => json!({"next_session":hex::encode(id)}),
                    None if matches!(
                        intent.action["type"].as_str(),
                        Some("create_room" | "join_room")
                    ) =>
                    {
                        json!({"room_id":self.room,"seats":self.seats})
                    }
                    None => self.game.view(),
                })
                .map_err(|e| e.to_string())?,
            ),
            Err(reason) => BusinessOutcome::Rejected(reason.into_bytes()),
        })
    }
    fn inspect(&self, query: &[u8]) -> std::result::Result<Vec<u8>, String> {
        if query != b"state" {
            return Err("Unsupported query".into());
        }
        serde_json::to_vec(
            &json!({"game":self.game.view(), "next_session":self.next_session.map(hex::encode),"admission":{"room_id":self.room,"solo":self.solo,"seats":self.seats}}),
        )
        .map_err(|e| e.to_string())
    }
}
fn profile(public: XOnlyPublicKey) -> AnyResult<ApplicationProfile> {
    Ok(CommandProfile {
        application_id: format!("{ID}/commands-v1"),
        program_digest: artifact()?,
        command_schema: hash(
            b"chess-json-intent-v1:action,expected_cursor,expected_block,actor-account-seat",
        ),
        authorization_policy: hash(
            &[
                b"gateway-BIP340;explicit-room-create-and-seat-admission;no-seat-transfer;solo-or-two-seats;terminal-new-game;"
                    .as_slice(),
                &public.serialize(),
            ]
            .concat(),
        ),
        entropy_policy: hash(b"no-game-randomness"),
        clock: ApplicationClock::CommandSteps,
        resources: ApplicationResourceEnvelope {
            max_frame_inputs: 1,
            max_frame_input_bytes: 8192,
            max_frame_cycles: 1,
            max_logical_time_span: 1,
            max_inspect_query_bytes: 32,
            max_inspect_result_bytes: 128_000,
        },
    }
    .build()?)
}
fn consensus(public: [u8; 33]) -> ConsensusConfig {
    ConsensusConfig::proof_of_authority(ProofOfAuthorityConfig {
        authorities: vec![Authority {
            id: ID.into(),
            public_key: public,
        }],
    })
}
fn restore(
    cfg: &SessionConfig,
    public: XOnlyPublicKey,
    bytes: &[u8],
) -> myelin_session::Result<CommandExecutor<Program>> {
    CommandExecutor::restore(cfg.clone(), bytes, Arc::new(Auth(public)), Program::restore)
        .map_err(SessionError::Execution)
}
pub struct App {
    root: PathBuf,
    namespace_lock: Arc<fs::File>,
    cfg: SessionConfig,
    authority: SessionAuthority<CommandExecutor<Program>>,
    journal: CommandJournal,
    worker: AuthoritySigner,
    auth: Keypair,
    finality: [u8; 33],
}
impl App {
    pub fn open(root: &Path) -> AnyResult<Self> {
        fs::create_dir_all(root)?;
        let lock = Arc::new(
            fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(root.join("namespace.lock"))?,
        );
        lock.try_lock()?;
        let active = root.join("active");
        if !active.exists()
            && fs::read_dir(root)?
                .any(|entry| entry.map_or(true, |e| e.file_name() != "namespace.lock"))
        {
            return Err(
                "Missing active session in a nonempty namespace; refusing to replace history"
                    .into(),
            );
        }
        let mut value = if active.exists() {
            let id = parse_id(fs::read_to_string(&active)?.trim())?;
            Self::open_session(root, id, false, lock)?
        } else {
            let id = random()?;
            let value = Self::prepare_session(root, id, lock)?;
            atomic(&active, hex::encode(id).as_bytes())?;
            value
        };
        value.activate_next()?;
        Ok(value)
    }
    // The old session's committed command is the durable creation intent. A
    // target becomes visible only after every database is closed and its whole
    // prepared directory is renamed. Incomplete preparation is disposable.
    fn prepare_session(root: &Path, id: Hash32, lock: Arc<fs::File>) -> AnyResult<Self> {
        let target = root.join(hex::encode(id));
        if !target.exists() {
            let staging = root.join(format!("preparing-{}", hex::encode(id)));
            if staging.exists() {
                fs::remove_dir_all(&staging)?;
            }
            drop(Self::open_session(root, id, true, lock.clone())?);
            #[cfg(unix)]
            fs::File::open(&staging)?.sync_all()?;
            #[cfg(test)]
            creation_fault("target-prepared");
            fs::rename(&staging, &target)?;
            #[cfg(unix)]
            fs::File::open(root)?.sync_all()?;
            #[cfg(test)]
            creation_fault("target-published");
        }
        Self::open_session(root, id, false, lock)
    }
    fn activate_next(&mut self) -> AnyResult<()> {
        let mut seen = HashSet::new();
        while let Some(id) = self.view()?["session"]["next_session"].as_str() {
            let id = parse_id(id)?;
            if !seen.insert(id) || id == self.cfg.session_id {
                return Err("Cyclic session creation".into());
            }
            let next = Self::prepare_session(&self.root, id, self.namespace_lock.clone())?;
            atomic(&self.root.join("active"), hex::encode(id).as_bytes())?;
            #[cfg(test)]
            creation_fault("active-published");
            *self = next;
        }
        Ok(())
    }
    fn open_session(
        root: &Path,
        id: Hash32,
        fresh: bool,
        namespace_lock: Arc<fs::File>,
    ) -> AnyResult<Self> {
        let key_path = root.join("command-roles.key");
        let secret: Hash32 = if key_path.exists() {
            fs::read(&key_path)?
                .try_into()
                .map_err(|_| "Invalid role secret")?
        } else {
            if !fresh || root.join("active").exists() {
                return Err("Existing session is missing its role secret".into());
            }
            let secret = random()?;
            atomic(&key_path, &secret)?;
            secret
        };
        let role = |name: &[u8]| hash(&[secret.as_slice(), name].concat());
        let finality = CommitteeSigner::new(ID, role(b"finality"))?;
        let public = finality.ckb_public_key();
        let administrator = AuthoritySigner::new(role(b"administrator"))?;
        let certificates = AuthoritySigner::new(role(b"certificates"))?;
        let worker = AuthoritySigner::new(role(b"worker"))?;
        let auth = Keypair::from_secret_key(
            &Secp256k1::new(),
            &SecretKey::from_slice(&role(b"admission"))?,
        );
        let auth_public = auth.x_only_public_key().0;
        let directory = root.join(if fresh {
            format!("preparing-{}", hex::encode(id))
        } else {
            hex::encode(id)
        });
        let cfg_path = directory.join("genesis");
        let cfg = if fresh {
            fs::create_dir(&directory)?;
            let profile = profile(auth_public)?;
            let verifier = RegisteredFinalityVerifier::new(consensus(public))?;
            let d = verifier.descriptor();
            let limits = CommitResourceLimits::default();
            let initial = CommandExecutor::initial_root(
                &profile,
                &Program::default(),
                0,
                0,
                limits.max_snapshot_bytes,
            )?;
            let cfg = SessionConfig {
                session_id: id,
                consensus_kind: d.consensus_kind,
                consensus_config_commitment: d.config_commitment,
                consensus_module_commitment: d.commitment(),
                consensus_wal_schema_hash: d.wal_schema_hash,
                application_profile: profile,
                initial_state_root: initial,
                initial_input_position: 0,
                initial_logical_time: 0,
                initial_timestamp_ms: 0,
                predecessor: None,
                max_block_transactions: 1,
                max_block_bytes: 8192,
                max_future_drift_ms: 0,
                commit_limits: limits,
                protocol_effects: ProtocolEffectsPolicy::Disabled,
            };
            atomic(&cfg_path, &cfg.encode()?)?;
            #[cfg(test)]
            creation_fault("target-genesis");
            cfg
        } else {
            SessionConfig::decode(&fs::read(&cfg_path)?)?
        };
        if cfg.session_id != id || cfg.application_profile != profile(auth_public)? {
            return Err("Session profile differs from this exact current executable".into());
        }
        if !fresh
            && (!directory.join("canonical/CURRENT").exists()
                || !directory.join("epochs/CURRENT").exists()
                || !directory.join("journal/CURRENT").exists())
        {
            return Err("Current session is missing its canonical store, authority epochs or original-command journal".into());
        }
        let authority = SessionAuthority::open(
            myelin_session_authority::CanonicalLedger::open(directory.join("canonical"))?,
            directory.join("epochs"),
            AuthorityConfig {
                session: cfg.clone(),
                consensus: consensus(public),
                administrator: administrator.public_key(),
                effect_domain: id,
            },
            AuthorityKeys {
                finality,
                certificates,
            },
            CommandExecutor::new(cfg.clone(), Program::default(), Arc::new(Auth(auth_public)))?,
            |bytes| restore(&cfg, auth_public, bytes).map_err(|e| e.to_string()),
        )?;
        #[cfg(test)]
        if fresh {
            creation_fault("target-authority");
        }
        let journal = CommandJournal::open_fenced(
            directory.join("journal"),
            &cfg,
            JournalLimits {
                max_entries: MAX_ACTIONS as usize + 1,
                max_command_bytes: 8192,
                max_authorization_bytes: 128,
                max_result_bytes: 128_000,
                ..JournalLimits::default()
            },
            authority.policy().clone(),
        )?;
        recover_local_commands(&authority, &journal, &administrator, &worker)?;
        let mut value = Self {
            root: root.into(),
            namespace_lock,
            cfg,
            authority,
            journal,
            worker,
            auth,
            finality: public,
        };
        value.drain()?;
        Ok(value)
    }
    fn drain(&mut self) -> AnyResult<()> {
        while let Some(reserved) = self.journal.reserve_commands(
            &self.authority.head()?,
            1,
            8192,
            &Auth(self.auth.x_only_public_key().0),
        )? {
            let head = self.authority.head()?;
            let grant = self.authority.current_grant()?.ok_or("No writer grant")?;
            let now = head.timestamp_ms.checked_add(1).ok_or("Time overflow")?;
            let request = request_from_reservation(&self.cfg, &reserved, now, now)?;
            let authorization =
                self.worker
                    .authorize_commit(self.authority.policy(), &grant, &head, &request)?;
            let binding = self.journal.begin_fenced_commit(
                reserved.token,
                self.authority.policy().clone(),
                grant,
                authorization,
                &request,
            )?;
            if let Err(error) = self
                .authority
                .commit(binding.authorization.clone(), request, now)
            {
                self.journal.mark_unknown(reserved.token)?;
                return Err(error.into());
            }
            let observed = self
                .authority
                .reconcile_submission(&binding.authorization, &binding.commands)?;
            self.journal
                .reconcile_fenced(reserved.token, &observed, business_result)?;
        }
        Ok(())
    }
    pub fn new_game(&mut self, body: Value, actor: Actor) -> AnyResult<Value> {
        let req: Request = serde_json::from_value(body.clone())?;
        if req.action != json!({"type":"new_game"}) || actor.seat != "solo" {
            return Err("New-game requests require the exact solo lifecycle command".into());
        }
        let session = parse_id(&req.session_id)?;
        let report = if session == self.cfg.session_id {
            let result = self.submit(body, actor)?;
            #[cfg(test)]
            creation_fault("intent-committed");
            self.activate_next()?;
            result["command"].clone()
        } else {
            // Resolve only an already-admitted historical identity. Never
            // enqueue new work in an old session or move the active pointer back.
            let mut past =
                Self::open_session(&self.root, session, false, self.namespace_lock.clone())?;
            if past.journal.entry(parse_id(&req.command_id)?)?.is_none() {
                return Err("New-game command was not admitted in the requested session".into());
            }
            past.submit(body, actor)?["command"].clone()
        };
        let mut view = self.view()?;
        view["command"] = report;
        Ok(view)
    }
    pub fn state(&mut self) -> AnyResult<Value> {
        self.activate_next()?;
        self.view()
    }
    pub fn view(&self) -> AnyResult<Value> {
        let head = self.authority.head()?;
        let inspect = command_inspector(
            self.cfg.clone(),
            Arc::new(Auth(self.auth.x_only_public_key().0)),
            Program::restore,
        );
        let inspected: Value =
            serde_json::from_slice(&self.authority.inspect_head(&inspect, b"state")?.result)?;
        let capabilities = CommandExecutor::new(
            self.cfg.clone(),
            Program::default(),
            Arc::new(Auth(self.auth.x_only_public_key().0)),
        )?
        .capabilities();
        Ok(
            json!({"game":inspected["game"],"admission":inspected["admission"],"capabilities":capabilities,"session":{"next_session":inspected["next_session"],"id":hex::encode(head.session_id),"height":head.finalised_height,
            "actions":head.input_position,"state_root":hex::encode(head.state_root),"block_hash":hex::encode(head.block_hash),
            "profile":hex::encode(self.cfg.application_profile.commitment()),"authority":hex::encode(self.finality),"mode":"gateway-attested-local-poa-host-replay","ckb_settled":false}}),
        )
    }
    pub fn command(&self, session: &str, command: &str) -> AnyResult<Value> {
        let id = parse_id(session)?;
        let command_id = parse_id(command)?;
        let entry = if id == self.cfg.session_id {
            self.journal.entry(command_id)?
        } else {
            let past = Self::open_session(&self.root, id, false, self.namespace_lock.clone())?;
            past.journal.entry(command_id)?
        };
        Ok(json!({"command_id":command,"session_id":session,"entry":entry}))
    }
    pub fn action(&mut self, body: Value, actor: Actor) -> AnyResult<Value> {
        if body["action"]["type"] == "new_game" {
            return Err("Use the new-game endpoint".into());
        }
        self.submit(body, actor)
    }
    fn submit(&mut self, body: Value, actor: Actor) -> AnyResult<Value> {
        actor.validate()?;
        let req: Request = serde_json::from_value(body)?;
        let id = parse_id(&req.command_id)?;
        if parse_id(&req.session_id)? != self.cfg.session_id
            || parse_id(&req.profile)? != self.cfg.application_profile.commitment()
        {
            return Err("Wrong command session/profile".into());
        }
        let intent = Intent {
            action: req.action,
            expected_cursor: req.expected_cursor,
            expected_block: req.expected_block,
            actor,
        };
        let payload = serde_json::to_vec(&intent)?;
        if self.journal.entry(id)?.is_none() {
            if !self.view()?["session"]["next_session"].is_null() {
                return Err("Session is closed; resolve its existing creation command".into());
            }
            let head = self.authority.head()?;
            if parse_id(&intent.expected_block)? != head.block_hash
                || intent.expected_cursor != head.input_position
            {
                return Err(
                    "Stale construction head; refresh before creating a new command".into(),
                );
            }
            if head.input_position > MAX_ACTIONS
                || (head.input_position == MAX_ACTIONS
                    && intent.action != json!({"type":"new_game"}))
            {
                return Err("Action limit reached".into());
            }
        }
        let mut original = OriginalCommand {
            scope: CommandScope::from_config(&self.cfg),
            identity: CommandIdentity {
                id,
                payload_hash: hash(&payload),
            },
            kind: InputKind::UserCommand,
            canonical_command: payload,
            authentication_context: self.auth.x_only_public_key().0.serialize().to_vec(),
            authorization: vec![],
        };
        original.authorization = Secp256k1::new()
            .sign_schnorr_no_aux_rand(
                &Message::from_digest(original.authorization_digest()),
                &self.auth,
            )
            .as_ref()
            .to_vec();
        self.journal
            .enqueue(original, &Auth(self.auth.x_only_public_key().0))?;
        self.drain()?;
        self.journal.acknowledge(id)?;
        let mut view = self.view()?;
        view["command"] = self.command(&req.session_id, &req.command_id)?;
        Ok(view)
    }
    pub fn replay(&self) -> AnyResult<Value> {
        let Some(end) = self.authority.head()?.finalised_height else {
            return Ok(json!({"verified":true,"frames":0}));
        };
        let cfg = self.cfg.clone();
        let public = self.auth.x_only_public_key().0;
        let receipt = self
            .authority
            .replay_range(0, end, move |bytes| restore(&cfg, public, bytes))?;
        let view = self.view()?;
        let mut game = Game::default();
        let mut positions = vec![game.view()["fen"].clone()];
        for uci in view["game"]["moves"]
            .as_array()
            .ok_or("Missing move history")?
        {
            game.apply(&json!({"type":"move","uci":uci}))?;
            positions.push(game.view()["fen"].clone());
        }
        Ok(
            json!({"positions":positions,"verified":true,"frames":receipt.frame_count,"receipt_commitment":hex::encode(receipt.commitment()),"state_root":hex::encode(receipt.state_root_after),"receipt":receipt}),
        )
    }
    pub fn export(&self) -> AnyResult<Value> {
        let head = self.authority.head()?;
        let mut blocks = vec![];
        let mut total = 0usize;
        for height in 0..head.next_height()? {
            let bytes = self.authority.block(height)?.encode()?;
            total = total
                .checked_add(bytes.len() * 2)
                .ok_or("Export size overflow")?;
            if total > 30 * 1024 * 1024 {
                return Err("Export exceeds bounded JSON size".into());
            }
            blocks.push(hex::encode(bytes));
        }
        Ok(
            json!({"format":"myelin-chess-commands-v1","application":ID,"authority":hex::encode(self.finality),
            "admission":hex::encode(self.auth.x_only_public_key().0.serialize()),"config":hex::encode(self.cfg.encode()?),"blocks":blocks,"head":hex::encode(head.encode()?)}),
        )
    }
}
pub fn verify_export(value: &Value) -> AnyResult<Value> {
    if value["format"] != "myelin-chess-commands-v1" || value["application"] != ID {
        return Err("Unsupported export format/application".into());
    }
    let get = |key: &str| -> AnyResult<Vec<u8>> {
        Ok(hex::decode(
            value[key].as_str().ok_or("Missing export field")?,
        )?)
    };
    let cfg = SessionConfig::decode(&get("config")?)?;
    let public = XOnlyPublicKey::from_slice(&get("admission")?)?;
    if cfg.application_profile != profile(public)? {
        return Err("Export requires its exact current executable and admitted profile".into());
    }
    let authority: [u8; 33] = get("authority")?
        .try_into()
        .map_err(|_| "Invalid authority")?;
    let verifier = Arc::new(RegisteredFinalityVerifier::new(consensus(authority))?);
    let dir = tempfile::tempdir()?;
    let store = Arc::new(RocksSessionStore::open(dir.path())?);
    let initial = CommandExecutor::new(cfg.clone(), Program::default(), Arc::new(Auth(public)))?;
    let mut chain = SessionChain::create(cfg, verifier, initial, store)?;
    let blocks = value["blocks"].as_array().ok_or("Missing blocks")?;
    if blocks.len() > MAX_ACTIONS as usize + 1 {
        return Err("Too many blocks".into());
    }
    for bytes in blocks {
        let record =
            FinalisedBlockRecord::decode(&hex::decode(bytes.as_str().ok_or("Invalid record")?)?)?;
        if !record.state_snapshot.is_empty()
            && restore(chain.config(), public, &record.state_snapshot)?.state_root()
                != record.block.state_root_after
        {
            return Err("Invalid snapshot".into());
        }
        if record.successor.is_some()
            || !record.issued_handoffs.is_empty()
            || !record.consumed_handoff_ids.is_empty()
            || !record.handoff_actions.is_empty()
        {
            return Err("Unsupported protocol effects".into());
        }
        let prepared = chain.prepare_block(BlockRequest {
            transactions: record.transactions,
            frame_input: record.frame_input,
            scheduler_commitment: record.block.scheduler_commitment,
            data_commitments: record.request_data_commitments,
            timestamp_ms: record.block.timestamp_ms,
            local_now_ms: record.block.timestamp_ms,
            successor: None,
            handoffs: vec![],
            consume_handoffs: vec![],
            handoff_actions: vec![],
        })?;
        if prepared.block().hash() != record.block.hash() || prepared.frame() != &record.frame {
            return Err("Replay differs from signed block".into());
        }
        chain.commit_finalised(prepared, record.proof)?;
    }
    if chain.head() != &SessionHead::decode(&get("head")?)? {
        return Err("Export head differs from replay".into());
    }
    Ok(
        json!({"verified":true,"frames":blocks.len(),"state_root":hex::encode(chain.head().state_root),"authority":hex::encode(authority),"canonical_fencing":"not-verified","trust":"application replay and ordinary PoA finality under a self-declared authority; canonical acceptance additionally requires an independently pinned fencing policy and canonical certificates"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(view: &Value, id: u8, action: Value) -> Value {
        json!({"command_id":hex::encode([id;32]),"session_id":view["session"]["id"],"profile":view["session"]["profile"],"expected_cursor":view["session"]["actions"],"expected_block":view["session"]["block_hash"],"action":action})
    }
    fn actor() -> Actor {
        Actor {
            account: hex::encode([7; 32]),
            seat: "solo".into(),
        }
    }
    #[test]
    fn duplicate_recovery_actor_isolation_and_signed_export() {
        if let Ok(path) = std::env::var("CHESS_CREATION_ROOT") {
            let mut app = App::open(Path::new(&path)).unwrap();
            let req = request(&app.view().unwrap(), 250, json!({"type":"new_game"}));
            app.new_game(req, actor()).unwrap();
            panic!("The selected process-exit boundary did not execute");
        }
        // Exercise interruption of real filesystem/database writes inside this
        // existing integration test, not a second mirrored lifecycle suite.
        for point in [
            "intent-committed",
            "target-genesis",
            "target-authority",
            "target-prepared",
            "target-published",
            "active-published",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let app = App::open(dir.path()).unwrap();
            assert!(
                App::open(dir.path()).is_err(),
                "namespace must have one owner"
            );
            let before = app.view().unwrap();
            let req = request(&before, 250, json!({"type":"new_game"}));
            drop(app);
            let child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "session::tests::duplicate_recovery_actor_isolation_and_signed_export",
                    "--nocapture",
                ])
                .env("CHESS_CREATION_ROOT", dir.path())
                .env("CHESS_CREATION_FAULT", point)
                .output()
                .unwrap();
            assert_eq!(
                child.status.code(),
                Some(86),
                "{point}: {}",
                String::from_utf8_lossy(&child.stderr)
            );
            let mut app = App::open(dir.path()).unwrap();
            let after = app.new_game(req.clone(), actor()).unwrap();
            assert_ne!(after["session"]["id"], before["session"]["id"], "{point}");
            assert_eq!(after["session"]["actions"], 0);
            let report = app
                .command(
                    req["session_id"].as_str().unwrap(),
                    req["command_id"].as_str().unwrap(),
                )
                .unwrap();
            assert_eq!(report, after["command"]);
            let original: OriginalCommand =
                serde_json::from_value(report["entry"]["original"].clone()).unwrap();
            let target = hex::encode(hash(
                &[
                    b"chess-new-session-v1".as_slice(),
                    &original.authorization_digest(),
                ]
                .concat(),
            ));
            assert_eq!(after["session"]["id"], target);
            assert_eq!(app.new_game(req, actor()).unwrap(), after);
            let past = App::open_session(
                dir.path(),
                parse_id(before["session"]["id"].as_str().unwrap()).unwrap(),
                false,
                app.namespace_lock.clone(),
            )
            .unwrap();
            assert_eq!(past.view().unwrap()["session"]["next_session"], target);
            assert_eq!(past.replay().unwrap()["frames"], 1);
            assert_eq!(
                verify_export(&past.export().unwrap()).unwrap()["verified"],
                true
            );
            assert!(!dir.path().join(format!("preparing-{target}")).exists());
            println!("Recovered creation after {point}");
        }
        let dir = tempfile::tempdir().unwrap();
        let mut app = App::open(dir.path()).unwrap();
        let before = app.view().unwrap();
        let req = request(&before, 1, json!({"type":"move","uci":"e2e4"}));
        let after = app.action(req.clone(), actor()).unwrap();
        assert_eq!(after["session"]["actions"], 1);
        assert_eq!(
            app.action(req.clone(), actor()).unwrap()["command"],
            after["command"]
        );
        assert!(app
            .action(
                req.clone(),
                Actor {
                    account: hex::encode([8; 32]),
                    ..actor()
                }
            )
            .is_err());
        assert!(app
            .action(
                request(&before, 2, json!({"type":"move","uci":"d2d4"})),
                actor()
            )
            .is_err());
        let mut conflict = req.clone();
        conflict["action"]["uci"] = json!("a2a4");
        assert!(app.action(conflict, actor()).is_err());
        assert_eq!(app.replay().unwrap()["frames"], 1);
        let export = app.export().unwrap();
        assert_eq!(verify_export(&export).unwrap()["verified"], true);
        drop(app);
        let active = fs::read(dir.path().join("active")).unwrap();
        fs::remove_file(dir.path().join("active")).unwrap();
        assert!(App::open(dir.path()).is_err());
        assert!(!dir.path().join("active").exists());
        fs::write(dir.path().join("active"), active).unwrap();
        let mut bad = export.clone();
        bad["admission"] = json!(hex::encode([9; 32]));
        assert!(verify_export(&bad).is_err());
        let mut app = App::open(dir.path()).unwrap();
        assert_eq!(
            app.action(req.clone(), actor()).unwrap()["command"],
            after["command"]
        );
        assert_eq!(app.view().unwrap()["game"], after["game"]);
        let new_request = request(&app.view().unwrap(), 3, json!({"type":"new_game"}));
        let new_view = app.new_game(new_request.clone(), actor()).unwrap();
        assert_ne!(new_view["session"]["id"], after["session"]["id"]);
        assert_eq!(new_view["session"]["actions"], 0);
        assert_eq!(
            app.new_game(new_request.clone(), actor()).unwrap(),
            new_view
        );
        drop(app);
        let mut app = App::open(dir.path()).unwrap();
        assert_eq!(app.new_game(new_request, actor()).unwrap(), new_view);
        assert!(app.action(req, actor()).is_err());
        assert_eq!(verify_export(&export).unwrap()["verified"], true);
    }
}
