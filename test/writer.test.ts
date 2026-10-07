import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryHost } from "../src/memory.ts";
import { keyValue } from "./helpers.ts";

// The test-only writer, checked by hand first: /w.conf is `a=1⏎b=2⏎`, 8 bytes, with a's value at
// 2-3 and b's at 6-7 (a, =, 1, newline = bytes 0-3; b, =, 2, newline = bytes 4-7).
const bytes = (text: string) => new TextEncoder().encode(text);

test("the key=value writer finds a value and writes a splice", () => {
  const w = bytes("a=1\nb=2\n");
  assert.equal(w.length, 8);
  assert.deepEqual(keyValue.locate(w, "a"), { ok: true, start: 2, end: 3 });
  assert.deepEqual(keyValue.locate(w, "b"), { ok: true, start: 6, end: 7 });
  assert.deepEqual(keyValue.locate(w, "c"), { ok: false, reason: "no key c" });
  assert.deepEqual(keyValue.write(w, "b", "3"), { ok: true, edit: { start: 6, end: 7, bytes: bytes("3") } });
  assert.equal(keyValue.claims("/w.conf"), true);
  assert.equal(keyValue.claims("/w.md"), false);
});

test("the writer counts bytes, not string units", () => {
  // `é` is two bytes: a=é is bytes 0-3, newline at 4, and b's value starts at 7 (b, =, then 7).
  assert.deepEqual(keyValue.locate(bytes("a=é\nb=2\n"), "b"), { ok: true, start: 7, end: 8 });
});

test("the memory host writes in place, atomically in the only sense it has, and says so", async () => {
  const host = createMemoryHost({ "/w.conf": "a=1\n" });
  assert.deepEqual(await host.write("/w.conf", bytes("a=2\n")), { ok: true });
  assert.deepEqual(await host.read("/w.conf"), { ok: true, bytes: bytes("a=2\n") });
});
