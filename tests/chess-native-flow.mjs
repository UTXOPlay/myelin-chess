import assert from "node:assert/strict";
import {commandRequest} from "../games/chess/web/commands.mjs";
import { chooseMove } from "../games/chess/client/strategy.mjs";
const base = process.env.STORE_URL || "http://127.0.0.1:19110";
let cookie = "";
async function req(path, body) {
  const r = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: base,
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  cookie =
    r.headers
      .getSetCookie()
      .map((s) => s.split(";")[0])
      .join("; ") || cookie;
  return { status: r.status, data: await r.json() };
}
const guest = await req("/api/guest", {});
assert.equal(guest.status, 200);
const route = "/games/chess/api";
let state = (await req(route + "/state")).data;
const original = state;
for (let i = 0; i < 24 && !state.game.result; i++) {
  const move = chooseMove({
    fen: state.game.fen,
    legal: state.game.legal_moves,
    level: i % 3 === 0 ? "club" : "rookie",
    random: () => 0,
  });
  assert.ok(move);
  const r = await req(route + "/action", commandRequest(state, { type: "move", uci: move }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  state = r.data;
}
assert.equal(
  (
    await req(route + "/action", commandRequest(original, { type: "move", uci: "e2e4" }))
  ).status,
  400,
);
const replay = await req(route + "/replay", {});
assert.equal(replay.data.verified, true);
assert.equal(replay.data.positions.at(-1), state.game.fen);
assert.equal(replay.data.frames, state.game.moves.length);
assert.equal(
  (await req(route + "/export")).data.blocks.length,
  state.game.moves.length,
);
console.log(
  "PASS native training match:",
  state.game.moves.length,
  "legal recorded plies; stale rejection, signed replay, FEN and export match",
);
state = (await req(route + "/new", commandRequest(state, {type:"new_game"}))).data;
for (const uci of ["f2f3", "e7e5", "g2g4", "d8h4"]) {
  const r = await req(route + "/action", commandRequest(state, { type: "move", uci }));
  assert.equal(r.status, 200);
  state = r.data;
}
assert.ok(state.game.result?.startsWith("Black"));
assert.equal((await req(route + "/replay", {})).data.verified, true);
console.log("PASS native mate and verified replay");
