# myelin-chess

Independent game service for chess. Source: https://github.com/UTXOPlay/myelin-chess.

The browser client, native runtime, game rules, assets and tests live here. The game runs without a UTXOPlay store checkout. Original source attribution and licenses are retained; see PROVENANCE.md and the game directories. Myelin supplies off-chain native replay, not CKB settlement.

## Build and run

Requires Node 22.23+, Rust 1.97.1, Clang/libclang, C/C++ tooling, CMake, pkg-config and protobuf compiler for native builds.

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

## Source layout and compatibility

`game-host.json` lists games, their browser package paths, native URL prefixes and native launch command. `games/` retains the original source layout so Myelin `include_bytes!` inputs remain byte-for-byte identical. `tools/build-web.mjs` packages each game's assets into its own URL namespace; it does not fetch store files. Shared presentation helpers are owned snapshots in this repository.

The default native build uses pinned Cargo lockfiles. Do not change profile inputs or replace an engine/verifier pair for existing signed exports. Rebuild the browser with `npm run build` after editing its source. Historical release documentation may refer to the pre-migration store layout.

## Deploy

```sh
docker build -f deploy/Standalone.Dockerfile -t myelin-chess:standalone .
# Create the shared private network once, then provide an untracked runtime.env.
docker compose -f deploy/standalone-compose.yml up -d
```

`deploy/runtime.env` supplies `RUNTIME_TOKEN` and `GAME_ORIGIN`; it is ignored by Git. Configure the store's service URL as `http://myelin-chess:8080` on the private `utxoplay-games` network. Bind or proxy host port 8080 only when standalone public play is wanted. Mount existing native data instead of initializing a new game history. The deployment does not expose native runtime ports.

## Existing online tables

Set `ROOMS_DATA_DIR` to a persistent directory for `rooms.sqlite`. Import old store membership with `node tools/import-store-rooms.mjs STORE_BACKUP.sqlite ROOMS.sqlite` while writers are stopped. This preserves room IDs and seats and does not rewrite native session files. Native room IDs continue to use the original account derivation.
