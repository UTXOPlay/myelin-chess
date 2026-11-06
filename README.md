# myelin-chess

Independent game service for chess. Source: https://github.com/UTXOPlay/myelin-chess.

The browser client, native runtime, game rules, assets and tests live here. The game runs without a UTXOPlay store checkout. Original source attribution and licenses are retained; see PROVENANCE.md and the game directories. Myelin supplies off-chain native replay, not CKB settlement.

## Build and run

Requires Node 22.23+, Rust 1.92.0, Clang/libclang, C/C++ tooling, CMake, pkg-config and protobuf compiler for native builds.

The source release includes `framework/myelin-source.tar` beside this game
directory. `deploy/myelin-source.sha256` pins its exact bytes; a framework Git
checkout or UTXOPlay store is not required. For a native developer build, verify
and extract that package into a new sibling directory first:

```sh
(cd ../framework && sha256sum --strict -c ../myelin-chess/deploy/myelin-source.sha256)
mkdir ../Myelin && tar -xf ../framework/myelin-source.tar -C ../Myelin
```

Do not merge the package into an existing framework tree. Cargo's explicit local
paths then resolve inside this unpacked release. Keep `source.json` with the tar;
it identifies the exact uncommitted framework candidate rather than claiming a
published upstream commit. Updating the dependency changes the checksum explicitly.

```sh
npm ci
npm run build
npm test
npm run test:host
npm run build:native
RUNTIME_TOKEN=<stable-random-secret-at-least-32-characters> npm start
```

Open http://127.0.0.1:8881/games/chess/. The host assigns a signed browser guest cookie; no wallet or store is required. Each configured game has its own `/games/<id>/` URL. `WEB_PORT` and `GAME_ORIGIN` configure the host. `DATA_DIR` holds native account saves; preserve it and the secret across restarts. Native services listen only on loopback. Use HTTPS and the exact `GAME_ORIGIN` when exposing the host publicly.

`RUNTIME_URL` can point to an already-running private native runtime; then the host does not start a child process. `RUNTIME_BINARY` overrides the native executable for a local build. `SESSION_SECRET` optionally separates cookie signing from the runtime token. Keep all secrets server-side. UTXOPlay integration uses authenticated `X-Runtime-Token` / `X-UTXOPlay-Account` requests to this host, preserving original account IDs. Independent browser guests have separate identities.

## Current command protocol

`game-host.json` lists browser package paths, native URL prefixes and the native
launch command. `tools/build-web.mjs` builds the game without store files.
Myelin's `CommandExecutor`, `CommandJournal`, `RegisteredFinalityVerifier` and
fenced local recovery own the shared execution/retry contracts. Chess rules and
gateway/seat admission remain in this repository.

Each action requires `command_id`, `session_id`, `profile`, `expected_block`,
`expected_cursor` and `action`. The browser persists the exact request in
session storage under the authenticated account and solo/table channel before
sending it, so it remains discoverable when the active session changes. `GET /api/commands/<session>/<command>`
returns the shared journal entry and its receipt/business outcome. After a lost
reply, reconnect queries that identity before retrying; a committed duplicate
returns the original outcome even after the turn changes. Another payload or
actor cannot reuse it. Business rejection is a committed outcome, distinct from
transport failure and unresolved submission. Unknown work stays pending.

`POST /api/new` requires the same command envelope with exactly
`action: {"type":"new_game"}`. The admitted solo command closes its source
session and records a deterministic target identity in replayable state. A fresh
game is prepared in a private directory, closed, synced and renamed before the
active pointer changes. Restart finishes an interrupted creation from the original
journal; no second lifecycle journal is used. Retrying the old identity returns
its original receipt and the current view, even after later new games. It never
moves the active pointer backward. Old-session command queries remain available
inside the same account namespace. A namespace file lock excludes a second local
process during creation and active-pointer changes. This is application-level
session creation, without protocol successor/state-inheritance claims. One terminal
creation command is permitted after the 1,000 command limit. Room admission
events consume positions in that same command budget.

Online room membership is authenticated by the host. `POST
/api/rooms/prepare/<command>/<color>` with an empty body reserves a deterministic
room ID and returns the native session/profile/head. The browser persists the
complete `create_room` command before `POST /api/rooms`. Invitations use
`GET /api/rooms/<id>/admission` to construct an exact-head `join_room` command
for `POST /api/rooms/<id>/join`. Both actions include `room_id` and `color`.
An already admitted player rejoins with a read, without consuming another frame.

The native original command signs the host's account/seat assertion; explicit
creation/join events bind both actors before any move. Gameplay requires both
admitted seats and the correct turn. First-move implicit admission is removed.
SQLite holds the routing/discovery index; its projected seat columns never grant
access. A successful canonical state read repairs a missing projection after a
lost commit response. Retries query the original journal entry before applying
current-head/seat checks, and never replace an unresolved ID. A prospective
member can query their own pending admission, but cannot read another actor's
journal entry or game state. The browser recovers pending room commands before
entering another table, including after reload. This is gateway attestation, not
a player wallet signature. Solo games have one admitted actor controlling both
sides. Seat transfer, leaving/rejoining as another actor,
handoffs, successors and CKB settlement are unsupported. `/api/state` includes
the profile-bound capability manifest.

Only MREC 13, block 6, store schema 15, journal 2 and the new
`myelin-chess-commands-v1` export are accepted. There is no old-store import,
schema upgrade, legacy command shape or room import utility. The room index
requires the exact current columns and never migrates an old membership table.
Start this profile
with a new data namespace. Missing active/genesis/epoch/journal metadata fails;
it does not silently replace history. The profile pins the complete running
executable. Keep that exact executable with its current-format export; another
build cannot reinterpret it. The export verifier reports its self-declared
authority. It verifies application replay and ordinary PoA finality, and explicitly
reports `canonical_fencing: not-verified`. A consumer requiring canonical writer
acceptance additionally needs an independently pinned policy and canonical
certificates; this bounded JSON export does not supply that proof.

The service contains the local administrator, canonical signer and worker roles.
Its exclusive databases support local restarts, not concurrent cloned authorities.
Move a deployment only through the upstream fencing procedure. Keep each release's
data and exact binary together; rolling back the service uses its separate data
namespace and never opens newer history with an older interpreter.

Run the existing controller and real-native integration checks after building:

```sh
node tests/chess-client-flow.mjs
CHESS_BINARY="$PWD/target/release/myelin-chess" node tests/chess-online-flow.mjs
```

The controller check uses DOM/transport doubles. The latter runs real Myelin
RocksDB/PoA execution, two room actors and isolated guests, loses replies after
commit, reconnects a recreated command client, rejects competing stale requests,
kills/restarts the native process and verifies the signed export. Neither is a
physical-device or deployed-container test. The existing native integration test
also exits at six creation boundaries (committed intent, target genesis, target
authority, prepared target, published target and active pointer), then opens the
same storage and checks the original receipt, exact target and replayed export.
Fault hooks are compiled only into the test binary. The HTTP flow holds a real
SQLite write lock after native room creation and before the host projection.
It verifies `SQLITE_BUSY`/HTTP 503, retains the original command, completes an
independent four-move game while index writes are unavailable, then releases the
lock and restarts both services. The original receipt/head and the other game's
receipts survive exactly, and canonical admission repairs the index. Raw commands,
receipts, signed exports and phase timings are included in the JSON report on
stdout. The join flow separately loses its response before projection, recovers
the exact original receipt and rejects a competing seat request. Its
signed replay includes both admission events, a committed illegal-move rejection
and a gateway-signed wrong-actor rejection exercised directly against native
execution, bypassing host membership checks. The old duplicate room route/cache mock suite is removed; those
checks, including authenticated SSE without extra native polling, run in the
existing real-native flow.

## Deploy

```sh
docker build --build-context myelin=../framework -f deploy/Standalone.Dockerfile -t myelin-chess:standalone .
# Create the shared private network once, then provide an untracked runtime.env.
docker compose -f deploy/standalone-compose.yml up -d
```

The named context contains the source tar, not a mutable framework checkout.
The native build verifies the checked-in SHA-256 before extraction. Rust/Node
base images are pinned by digest; Cargo/npm use lockfiles. No source build target,
runtime data or credentials from the developer machine enter the final image.
The image retains `myelin-source.sha256` beside its exact native executable.

`deploy/runtime.env` supplies `RUNTIME_TOKEN` and `GAME_ORIGIN`; it is ignored by Git. Configure the store's service URL as `http://myelin-chess:8080` on the private `utxoplay-games` network. Bind or proxy host port 8080 only when standalone public play is wanted. Mount this exact current release's data namespace. The deployment does not expose native runtime ports.

## Current online tables

Set `ROOMS_DATA_DIR` to a persistent directory for this release's `rooms.sqlite`.
Preserve it alongside the corresponding native account saves across restarts.
