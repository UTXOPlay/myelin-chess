import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { optimizedStatic } from "../host/static.mjs";
import {
  ResolutionBudget,
  startRenderLoop,
  startPolling,
} from "../shared/game-performance.mjs";

test("adaptive resolution waits for sustained load and does not oscillate on isolated slow frames", () => {
  const budget = new ResolutionBudget(2);
  for (let i = 0; i < 1000; i++) budget.sample(i % 10 === 0 ? 35 : 16);
  assert.equal(budget.ratio, 2);
  for (let i = 0; i < 90; i++) budget.sample(30);
  assert.equal(budget.ratio, 1.75);
  for (let i = 0; i < 599; i++) budget.sample(16);
  assert.equal(budget.ratio, 1.75);
  budget.sample(16);
  assert.equal(budget.ratio, 2);
  for (let i = 0; i < 1000; i++) budget.sample(35);
  assert.equal(budget.ratio, 0.75);
  assert.equal(budget.sample(35, "high"), 2);
  assert.equal(budget.sample(16, "low"), 1);
});

test("rendering keeps ~60 frames on a 144 Hz screen, stops while hidden, resumes with bounded delta", () => {
  const originals = new Map(
    [
      "document",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "addEventListener",
      "removeEventListener",
    ].map((k) => [k, globalThis[k]]),
  );
  const doc = new EventTarget();
  doc.hidden = false;
  doc.documentElement = { dataset: {} };
  let callbacks = new Map(),
    id = 0,
    count = 0,
    maxDelta = 0;
  Object.assign(globalThis, {
    document: doc,
    requestAnimationFrame: (cb) => {
      callbacks.set(++id, cb);
      return id;
    },
    cancelAnimationFrame: (id) => callbacks.delete(id),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  let stop;
  try {
    stop = startRenderLoop((now, dt) => {
      count++;
      maxDelta = Math.max(maxDelta, dt);
    });
    for (let i = 1; i <= 144; i++) {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const cb of pending) cb((i * 1000) / 144);
    }
    assert.ok(count >= 59 && count <= 61, `Rendered ${count} frames`);
    doc.hidden = true;
    doc.dispatchEvent(new Event("visibilitychange"));
    assert.equal(callbacks.size, 0);
    doc.hidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    assert.equal(callbacks.size, 1);
    for (const cb of [...callbacks.values()]) cb(100000);
    assert.ok(maxDelta <= 50);
  } finally {
    stop?.();
    for (const [k, v] of originals)
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
  }
});

test("polling never overlaps and skips hidden tabs", async () => {
  const original = globalThis.document;
  const doc = new EventTarget();
  doc.hidden = false;
  globalThis.document = doc;
  let inFlight = 0,
    peak = 0,
    count = 0,
    finish;
  const stop = startPolling(
    async () => {
      count++;
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => (finish = r));
      inFlight--;
    },
    { interval: 2 },
  );
  const tick = () => new Promise((r) => setTimeout(r, 10));
  try {
    await tick();
    doc.dispatchEvent(new Event("visibilitychange"));
    await tick();
    assert.equal(count, 1);
    assert.equal(peak, 1);
    doc.hidden = true;
    finish();
    await tick();
    assert.equal(count, 1);
    doc.hidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    await tick();
    assert.equal(count, 2);
    assert.equal(peak, 1);
    finish();
  } finally {
    stop();
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
  }
});
