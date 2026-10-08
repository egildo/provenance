import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { openSession } from "../src/index.ts";
import type { Change, Session } from "../src/index.ts";
import { createNodeHost } from "../src/node.ts";
import { byLocation, closing, include, keyValue, scratch } from "./helpers.ts";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function directory(t: TestContext, files: Record<string, string>): Promise<string> {
  const dir = await scratch(t, "provenance-");
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content);
  return dir;
}

/** Every change the session reports, and a way to wait for the next one. */
function changes(session: Session) {
  const seen: Change[] = [];
  let waiting: (() => void) | undefined;
  session.onChange(change => {
    seen.push(change);
    waiting?.();
  });
  const next = () =>
    new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no change within 5 s")), 5000);
      waiting = () => (clearTimeout(timeout), resolve());
    });
  return { seen, next };
}

async function open(t: TestContext, dir: string) {
  const session = closing(t, await openSession({ host: createNodeHost({ debounce: 50 }), entry: path.join(dir, "a.md"), handlers: [include] }));
  await sleep(100); // let the platform's watchers start before the test writes
  return { session, ...changes(session) };
}

test("a broken include heals when its file appears on disk", async t => {
  const dir = await directory(t, { "a.md": '@include{src="missing.md"}\n' });
  const { session, next } = await open(t, dir);
  assert.equal(session.unresolved().length, 1);
  const healed = next();
  await fs.writeFile(path.join(dir, "missing.md"), "found\n");
  await healed;
  assert.deepEqual(session.unresolved(), []);
  assert.equal(byLocation(session, path.join(dir, "missing.md")).state, "analysed");
});

test("a change on disk is one change; identical bytes are none", async t => {
  const dir = await directory(t, { "a.md": '@include{src="b.md"}\n', "b.md": "one\n" });
  const { session, seen, next } = await open(t, dir);
  const b = byLocation(session, path.join(dir, "b.md"));

  const changed = next();
  await fs.writeFile(path.join(dir, "b.md"), "two\n");
  await changed;
  assert.deepEqual(seen, [{ added: [], removed: [], changed: [b.id] }]);

  await fs.writeFile(path.join(dir, "b.md"), "two\n");
  await sleep(300);
  assert.equal(seen.length, 1);
});

test("a write-then-rename save is one change", async t => {
  const dir = await directory(t, { "a.md": '@include{src="b.md"}\n', "b.md": "one\n" });
  const { session, seen, next } = await open(t, dir);
  const b = byLocation(session, path.join(dir, "b.md"));

  const changed = next();
  await fs.writeFile(path.join(dir, "b.md.tmp"), "saved\n");
  await fs.rename(path.join(dir, "b.md.tmp"), path.join(dir, "b.md"));
  await changed;
  await sleep(300);
  assert.deepEqual(seen, [{ added: [], removed: [], changed: [b.id] }]);
});

test("canonicalize follows a symlink; a missing file has no identity", async t => {
  const dir = await directory(t, { "real.md": "" });
  await fs.symlink(path.join(dir, "real.md"), path.join(dir, "link.md"));
  const host = createNodeHost();
  assert.equal(await host.canonicalize(path.join(dir, "link.md")), path.join(dir, "real.md"));
  assert.equal(await host.canonicalize(path.join(dir, "missing.md")), undefined);
  const refused = await host.read(path.join(dir, "missing.md"));
  assert.equal(refused.ok, false);
});

test("write replaces a file through a temporary file and a rename, so a reader never sees half of it", async t => {
  const dir = await directory(t, { "w.conf": "a=1\n" });
  const host = createNodeHost();
  const file = path.join(dir, "w.conf");
  const before = await fs.stat(file);
  assert.deepEqual(await host.write?.(file, new TextEncoder().encode("a=22\n")), { ok: true });
  assert.equal(await fs.readFile(file, "utf8"), "a=22\n");
  // A rename gives the file a new inode; an in-place write would keep the old one.
  assert.notEqual((await fs.stat(file)).ino, before.ino);
  assert.equal((await fs.stat(file)).mode, before.mode);
  assert.deepEqual(await fs.readdir(dir), ["w.conf"]); // no temporary file left behind
});

test("a failed write says why, and leaves nothing behind", async t => {
  const dir = await directory(t, {});
  const host = createNodeHost();
  const result = await host.write?.(path.join(dir, "missing", "w.conf"), new Uint8Array([97]));
  assert.equal(result?.ok, false);
  assert.deepEqual(await fs.readdir(dir), []);
});

test("a commit through the Node host writes the file, and the session hears its own write once", async t => {
  const dir = await directory(t, { "w.conf": "a=1\nb=2\n" });
  const file = path.join(dir, "w.conf");
  const session = closing(t, await openSession({ host: createNodeHost({ debounce: 50 }), entry: file, handlers: [], writers: [keyValue], writable: [dir] }));
  await sleep(100);
  const { seen } = changes(session);
  assert.deepEqual(await session.stage(file, "b", "3"), { ok: true });
  const report = await session.commit();
  assert.equal(report.sources[0]?.outcome, "written");
  assert.equal(await fs.readFile(file, "utf8"), "a=1\nb=3\n");
  await sleep(400); // the watcher reports the write; the session already holds that version
  assert.equal(seen.length, 1);
  assert.deepEqual(await fs.readdir(dir), ["w.conf"]);
});
