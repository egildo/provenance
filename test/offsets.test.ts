import { test } from "node:test";
import assert from "node:assert/strict";
import { byteOffsets } from "../src/offsets.ts";
import { openSession } from "../src/index.ts";
import { createMemoryHost } from "../src/memory.ts";

const bytes = (s: string) => new TextEncoder().encode(s).length;

test("counts UTF-8 bytes, not string units", () => {
  const text = "café ✓ 𝄞 x";
  const i = text.indexOf("x");
  assert.equal(i, 10);
  assert.deepEqual(byteOffsets(text, [i]), [15]);
});

test("a byte-order mark is three bytes", () => {
  const text = "﻿a";
  assert.deepEqual(byteOffsets(text, [1]), [3]);
});

test("unsorted and repeated indices keep their order", () => {
  const text = "é𝄞a";
  assert.deepEqual(byteOffsets(text, [3, 0, 1, 3]), [6, 0, 2, 6]);
});

test("the ends of the text", () => {
  const text = "a✓𝄞é";
  assert.deepEqual(byteOffsets(text, [0, text.length]), [0, bytes(text)]);
});

test("agrees with TextEncoder at every index", () => {
  const text = "a é ✓ 𝄞 ﻿ z";
  const indices = [...text].reduce<number[]>((acc, ch) => [...acc, (acc.at(-1) ?? 0) + ch.length], [0]);
  assert.deepEqual(byteOffsets(text, indices), indices.map(i => bytes(text.slice(0, i))));
});

test("a high surrogate is a pair's first half only before a low surrogate", () => {
  assert.deepEqual(byteOffsets("\ud800ab", [0, 1, 2, 3]), [0, 3, 4, 5]);
  assert.deepEqual(byteOffsets("a\ud800", [0, 1, 2]), [0, 1, 4]);
  assert.deepEqual(byteOffsets("\udc00a", [0, 1, 2]), [0, 3, 4]);
  assert.deepEqual(byteOffsets("\ud800\ud800\udc00", [0, 1, 3]), [0, 3, 7]);
  assert.deepEqual(byteOffsets("x😀y", [0, 1, 3, 4]), [0, 1, 5, 6]);
});

test("agrees with TextEncoder at every convertible index of texts with lone surrogates", () => {
  for (const text of ["\ud800", "\udc00", "\ud800\ud800", "a\udc00\ud800b", "\ud800\ud800\udc00\udc00", "😀\ud83d", "é\ud800x😀"]) {
    // Every index but one between the halves of a pair.
    const indices = Array.from({ length: text.length + 1 }, (_, i) => i).filter(i => !(i > 0 && /[\ud800-\udbff]/.test(text[i - 1] ?? "") && /[\udc00-\udfff]/.test(text[i] ?? "")));
    assert.deepEqual(byteOffsets(text, indices), indices.map(i => bytes(text.slice(0, i))), JSON.stringify(text));
  }
});

test("the end of the text, and the empty text, are valid", () => {
  assert.deepEqual(byteOffsets("ab", [2]), [2]);
  assert.deepEqual(byteOffsets("", [0]), [0]);
});

test("an index it cannot convert is a handler bug and throws a RangeError naming it and why", () => {
  const cases: [string, number, RegExp][] = [
    ["ab", 3, /3.*past the end/],
    ["ab", -1, /-1.*negative/],
    ["ab", 1.5, /1\.5.*not an integer/],
    ["ab", NaN, /NaN.*not an integer/],
    ["ab", Infinity, /Infinity.*not an integer/],
    ["x😀y", 2, /2.*inside a surrogate pair/],
  ];
  for (const [text, index, message] of cases) {
    assert.throws(() => byteOffsets(text, [index]), error => error instanceof RangeError && message.test(error.message), `${index}`);
  }
});

test("one bad index among good ones throws", () => {
  assert.throws(() => byteOffsets("abc", [0, 9, 1]), RangeError);
});

test("through a session, a request ending past the text rejects the call that triggered it", async () => {
  const handler = { claims: (l: string) => l.endsWith(".md"), analyze: (text: string) => text === "bad" ? { requests: [{ start: 0, end: 4, request: "x", kind: "requires" as const }] } : { requests: [] } };
  const host = createMemoryHost({ "/a.md": "fine", "/bad.md": "bad" });
  const session = await openSession({ host, entry: "/a.md", handlers: [handler] });
  await assert.rejects(session.addRoot("/bad.md"), RangeError);
  assert.deepEqual(session.sources().map(s => s.location), ["/a.md"]);
});
