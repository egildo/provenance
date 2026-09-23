import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryHost } from "../src/memory.ts";

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test("POSIX paths", () => {
  const { paths } = createMemoryHost();
  assert.equal(paths.resolve("/a/b", "../c"), "/a/c");
  assert.equal(paths.resolve("/a", "./b/./c"), "/a/b/c");
  assert.equal(paths.resolve("/a", "/x/y"), "/x/y");
  assert.equal(paths.dirname("/a/b.md"), "/a");
  assert.equal(paths.dirname("/b.md"), "/");
  assert.equal(paths.isAbsolute("/a"), true);
  assert.equal(paths.isAbsolute("a"), false);
});

test("canonicalize answers only for something that is there", async () => {
  const host = createMemoryHost({ "/d/a.md": "a" });
  assert.equal(await host.canonicalize("/d/x/../a.md"), "/d/a.md");
  assert.equal(await host.canonicalize("/d/missing.md"), undefined);
});

test("read returns bytes or a refusal", async () => {
  const host = createMemoryHost({ "/a.md": "é" });
  assert.deepEqual(await host.read("/a.md"), { ok: true, bytes: new TextEncoder().encode("é") });
  assert.deepEqual(await host.read("/missing.md"), { ok: false, reason: "not found" });
  host.refuse("/a.md", "permission denied");
  assert.deepEqual(await host.read("/a.md"), { ok: false, reason: "permission denied" });
});

test("changes in one synchronous run arrive as one batch, only for watched locations", async () => {
  const host = createMemoryHost();
  const batches: (readonly string[])[] = [];
  const watch = host.watch(batch => batches.push(batch));
  watch.set(["/a.md", "/b.md"]);
  host.write("/a.md", "1");
  host.write("/b.md", "2");
  host.write("/c.md", "3");
  await tick();
  assert.deepEqual(batches, [["/a.md", "/b.md"]]);
  watch.close();
  host.write("/a.md", "4");
  await tick();
  assert.equal(batches.length, 1);
});
