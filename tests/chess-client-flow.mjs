// Shipped controller with DOM/transport doubles; real rendering and native replay are separate checks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import path from "node:path";
import { build } from "esbuild";
import { Chess } from "chess.js";
const result = await build({
  entryPoints: ["games/chess/web/app.js"],
  bundle: true,
  write: false,
  format: "iife",
  plugins: [
    {
      name: "controller-test",
      setup(b) {
        b.onLoad({ filter: /web\/app\.js$/ }, (a) => ({
          contents: readFileSync(a.path, "utf8").replace(
            "await startTable();",
            "void startTable();",
          ),
          loader: "js",
          resolveDir: path.dirname(a.path),
        }));
        b.onLoad({ filter: /web\/audio\.js$/ }, () => ({
          contents:
            "export async function toggleSound(){return true};export function sound(){};export function volume(){};export const savedVolume=()=>.3;",
          loader: "js",
        }));
        b.onLoad({ filter: /web\/performance\.mjs$/ }, () => ({
          contents: "export function startPolling(){}",
          loader: "js",
        }));
      },
    },
  ],
});
const dom = new JSDOM(readFileSync("games/chess/web/index.html", "utf8"), {
    url: "http://localhost/games/chess/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  }),
  w = dom.window,
  d = w.document;
w.TextDecoder = TextDecoder;
w.matchMedia = () => ({ matches: false });
w.HTMLElement.prototype.setPointerCapture = () => {};
w.HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
w.HTMLDialogElement.prototype.close = function () {
  this.open = false;
  this.dispatchEvent(new w.Event("close"));
};
w.localStorage.setItem(
  "chess:preferences",
  JSON.stringify({ opponent: "club", color: "black" }),
);
const chess = new Chess();
let actions = 0,
  worker,
  verified = true,
  replyDelay = false,
  failMove = 2,
  pending;
const snapshots = [chess.fen()];
const receipts = new Map();
let sessionId = "01".repeat(32);
const profileId = "02".repeat(32);
const state = () => ({
  game: {
    fen: chess.fen(),
    moves: chess
      .history({ verbose: true })
      .map((m) => m.from + m.to + (m.promotion || "")),
    legal_moves: chess
      .moves({ verbose: true })
      .map((m) => m.from + m.to + (m.promotion || "")),
    turn: chess.turn() === "w" ? "white" : "black",
    result: null,
    in_check: chess.isCheck(),
    can_claim_draw: false,
  },
  session: { id: sessionId, profile: profileId, block_hash: String(actions), actions },
});
class Worker {
  constructor() {
    worker = this;
  }
  postMessage(v) {
    this.request = v;
    if(v==='uci')queueMicrotask(()=>this.onmessage({data:'uciok'}));
    if(v==='isready')queueMicrotask(()=>this.onmessage({data:'readyok'}));
  }
  terminate() {
    this.terminated = true;
  }
}
w.Worker = Worker;
function record(b) {
  const intent = {action:b.action,expected_cursor:b.expected_cursor,expected_block:b.expected_block,actor:{account:"03".repeat(32),seat:"solo"}};
    const report = {command_id:b.command_id,session_id:b.session_id,entry:{original:{identity:{id:Array.from(Buffer.from(b.command_id,"hex"))},scope:{session_id:Array.from(Buffer.from(b.session_id,"hex")),application_profile:Array.from(Buffer.from(profileId,"hex"))},canonical_command:Array.from(Buffer.from(JSON.stringify(intent)))},status:{Committed:{outcome:{Succeeded:[]}}}}};
    receipts.set(b.command_id,report);
  return report;
}
w.fetch = async (url, options) => {
  let payload;
  if (url.endsWith("/action")) {
    if (failMove) {
      failMove--;
      return {
        ok: false,
        json: async () => ({ error: "Temporary storage failure" }),
      };
    }
    const b = JSON.parse(options.body);
    assert.equal(b.expected_block, String(actions));
    chess.move({
      from: b.action.uci.slice(0, 2),
      to: b.action.uci.slice(2, 4),
      promotion: b.action.uci[4],
    });
    actions++;
    snapshots.push(chess.fen());
    if (replyDelay) await new Promise((r) => (pending = r));
    const report = record(b);
    payload = {...state(),command:report};
  } else if(url.endsWith("/new")) {
    const b = JSON.parse(options.body);
    assert.equal(b.action.type, "new_game");
    const report = record(b);
    sessionId = "04".repeat(32); actions = 0;
    snapshots.splice(0, snapshots.length, chess.fen());
    payload = {...state(), command:report};
  } else if(url.includes("/commands/"))payload=receipts.get(url.split("/").at(-1))||{entry:null};
  else if (url.endsWith("/replay"))
    payload = { verified, frames: actions, positions: [...snapshots] };
  else if(url==="/api/me")payload={user:{guest:true,id:"03".repeat(32)}};
  else payload = state();
  return { ok: true, json: async () => payload };
};
const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const menu = (open) =>
  d.dispatchEvent(new w.CustomEvent("utxoplay:menu", { detail: { open } }));
try {
  w.eval(result.outputFiles[0].text);
  await settle(520);
  assert.ok(worker?.request);
  const old = worker,
    oldId = worker.request.id;
  menu(true);
  assert.equal(old.terminated, true);
  old.onmessage({ data: "bestmove e2e4" });
  await settle();
  assert.equal(actions, 0, "terminated worker cannot submit a stale move");
  menu(false);
  await settle(520);
  worker.onmessage({ data: "bestmove e2e4" });
  await settle();
  assert.equal(actions, 0);
  assert.equal(d.querySelector("#bot-retry").hidden, false);
  const pausedWorker = worker;
  await settle(520);
  assert.equal(
    worker,
    pausedWorker,
    "failed saves must not retry automatically",
  );
  d.querySelector("#bot-retry").click();
  await settle(520);
  worker.onmessage({ data: "bestmove e2e4" });
  await settle();
  assert.equal(actions, 1);
  assert.ok(d.querySelector("[data-square=e4]").dataset.piece === "P");
  // Illegal human destinations do not reach native transport; double-clicks are serialized.
  d.querySelector("[data-square=e7]").click();
  d.querySelector("[data-square=e4]").click();
  await settle();
  assert.equal(actions, 1);
  d.querySelector("[data-square=e7]").click();
  replyDelay = true;
  d.querySelector("[data-square=e5]").click();
  d.querySelector("[data-square=d7]").click();
  d.querySelector("[data-square=d5]").click();
  await settle();
  assert.equal(actions, 2);
  pending();
  await settle();
  replyDelay = false;
  menu(true);
  verified = false;
  d.querySelector("#review-first").click();
  await settle();
  assert.match(d.querySelector("#toast").textContent, /could not be verified/);
  assert.equal(d.body.classList.contains("reviewing"), false);
  verified = true;
  d.querySelector("#review-first").click();
  await settle();
  assert.equal(d.body.classList.contains("reviewing"), true);
  assert.equal(d.querySelector("[data-square=e2]").dataset.piece, "P");
  const before = actions;
  d.querySelector("[data-square=e2]").click();
  d.querySelector("[data-square=e4]").click();
  await settle();
  assert.equal(actions, before);
  d.querySelector("#review-live").click();
  assert.equal(d.body.classList.contains("reviewing"), false);
  assert.equal(d.querySelector('[data-ply="1"]').textContent, "e4");
  // Promotion keeps an explicit choice, and repeated clicks cannot submit twice.
  chess.load("k7/6P1/6K1/8/8/8/8/8 w - - 0 1");
  d.querySelector("#opponent").value = "local";
  d.querySelector("#new").click();
  await settle();
  d.querySelector("#confirm-yes").click();
  await settle();
  d.querySelector("[data-square=g7]").click();
  d.querySelector("[data-square=g8]").click();
  await settle();
  assert.equal(d.querySelector("#promotion").open, true);
  assert.equal(d.querySelectorAll("#promotion-choices button").length, 4);
  const promotion = d.querySelector(
    '#promotion-choices [aria-label="Promote to queen"]',
  );
  promotion.click();
  promotion.click();
  await settle();
  assert.equal(actions, 1);
  assert.equal(d.querySelector("[data-square=g8]").dataset.piece, "Q");
  console.log(
    "PASS shipped Chess controller: worker cancellation/stale replies, native moves, illegal and duplicate input, failed verification, read-only review, SAN journal",
  );
} finally {
  w.dispatchEvent(new w.Event("pagehide"));
  w.close();
}
