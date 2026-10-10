# The Quiet Board · Myelin Chess

![Original game environment](web/assets/study.png)

A playable browser game backed by **real Rust `myelin-session`**, signed local PoA blocks, RocksDB persistence, and deterministic replay. An independent Myelin Labs application; the Myelin core repository is pinned, not vendored or modified.

- 双人同屏国际象棋；合法落点、将军/将死、易位、吃过路兵、升变选择。
- 投降与三次重复 / 五十步规则的主动和棋声明。
- 棋盘翻转、走子记录、逐步回放、可下载对局证据。
- 原创象牙与深胡桃木棋子、暖色棋室、竖琴配乐。

## Run

Prerequisites: Rust 1.92.0 (installed through `rustup`), a C/C++ compiler, Clang/libclang, and Git. On Ubuntu: `sudo apt install build-essential clang libclang-dev pkg-config`. The first build includes RocksDB and may take several minutes. No Node.js, wallet, CKB node, or external API key is needed.

```bash
git clone https://github.com/Myelin-Labs/myelin-chess.git
cd myelin-chess
cargo run --locked
```

Open **http://127.0.0.1:8781**. Two tabs share the active local session. The service intentionally binds to loopback; this first version is local play, without remote player authentication. Music starts only after pressing **Sound on**. Art, music, and scripts are served locally, with no runtime CDN dependency.

```bash
# Separate data directory / port
DATA_DIR=/tmp/myelin-chess-demo PORT=8781 cargo run --locked
```

The default `data/` directory stores the generated authority key, active-session pointer, and RocksDB history. It is ignored by Git. A new match creates a new session identity and retains previous records in the database; export before switching if you want a convenient standalone copy. Restarting the server audits signatures and replays the active history before accepting new actions. Changing the bound program or dependency lock requires a new data directory; old sessions must be replayed with their original build.

## What actually passes through Myelin

```text
Browser action + expected session/head
  → validated FrameInput
  → Game TransitionExecutor (isolated cloned state)
  → SessionChain.prepare_block
  → secp256k1 PoA seal + Myelin finality verification
  → atomic RocksSessionStore commit
  → browser state + signed block / state commitments
```

Each accepted action advances one frame. Illegal or stale actions do not advance the head. Genesis binds the game source, adapter source and `Cargo.lock`; frames bind ordered input, logical time, pre/post state, and execution evidence. A session is bounded to 1,000 actions.

**Execution boundary:** this is an application-frame / host-executor demo. Frames contain game commands and **zero CellTxs**; CKB-VM cycle usage is zero because no CKB scripts execute. Myelin's `ApplicationVmProfile` reserves strict capabilities for CellTx execution; it does not certify this host game. The court-profile commitment explicitly identifies host replay only. Local PoA finality is a single local authority, not player consent, permissionless consensus, CKB settlement, or a fraud proof. There are no deposits, withdrawals, token rewards, or chain submissions.

## Export and independently verify

Use **Save match** to download `session.json`, containing the genesis configuration, public authority, versioned signed records, and expected head. No private key is exported.

```bash
cargo run --locked -- verify session.json
```

Verification reconstructs the game from genesis in a temporary database, checks the bound program, re-executes every action, checks every frame/block and signature, and compares the terminal head. It requires neither the original database nor the signing key. This checks consistency relative to the exported authority; authenticate that public key separately if verifying another operator's evidence.

## Validate

```bash
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --locked
python3 tests/http_smoke.py target/debug/myelin-chess
```

Optional DOM integration tests (Node.js 22+): `npm ci && npm run test:ui`. These execute UI handlers against the real server in a DOM test environment; they do not replace visual browser QA.

Tests cover gameplay, deterministic replay, signed persistence/restart, stale requests, tampered evidence and the actual HTTP API. This is casual untimed hot-seat chess; there is no AI, matchmaking, tournament clock, or remote seat ownership.

## Art, music and references

See [ASSETS.md](ASSETS.md) for per-file provenance, licenses, and production prompts, and [REFERENCES.md](REFERENCES.md) for the upstream references and implementation choices. Music credits are also available inside the game. Application code is MIT; third-party audio retains its CC BY 4.0 license.
