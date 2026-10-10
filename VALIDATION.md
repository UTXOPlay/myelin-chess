# Validation — 2026-10-11

Passed on Linux with Rust 1.92.0 and Node.js 22:

- Rust formatting and Clippy with warnings denied.
- Game rule and deterministic execution tests.
- Real Myelin signed commit, complete range replay, recovery and altered-record rejection.
- HTTP end-to-end gameplay, static image/music delivery, stale/illegal action rejection, origin protection, standalone export verification, and restart.
- DOM integration tests exercising the actual interface JavaScript against the real Rust server, including gameplay submission, replay and credits.
- PNG alpha/dimensions, audio decoding metadata, and checked-in asset SHA-256 manifests.

Chess: four Rust tests; end-to-end Fool's Mate, special-move legality, repetition draw and UI selection/move/flip/replay.

Visual browser QA and actual browser audio playback were unavailable because this environment exposed no browser connection. DOM tests do not assert rendered pixels, responsive appearance, or audible output. The projects include responsive CSS and local playable previews, but those aspects still need a real browser pass.

These checks verify the local session applications. They do not establish CKB script execution, public network security, player authorization, or on-chain settlement.
