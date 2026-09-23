import { test } from "node:test";
import assert from "node:assert/strict";
import { byteOffsets } from "../src/offsets.ts";

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
