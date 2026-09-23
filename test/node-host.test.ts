import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSession } from "../src/index.ts";
import type { Change, Session } from "../src/index.ts";
import { createNodeHost } from "../src/node.ts";
import { byLocation, include } from "./helpers.ts";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function directory(files: Record<string, string>): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "provenance-")));
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

async function open(dir: string) {
  const session = await openSession({ host: createNodeHost({ debounce: 50 }), entry: path.join(dir, "a.md"), handlers: [include] });
  await sleep(100); // let the platform's watchers start before the test writes
  return { session, ...changes(session) };
}

test("a broken include heals when its file appears on disk", async () => {
  const dir = await directory({ "a.md": '@include{src="missing.md"}\n' });
  const { session, next } = await open(dir);
  assert.equal(session.unresolved().length, 1);
  const healed = next();
  await fs.writeFile(path.join(dir, "missing.md"), "found\n");
  await healed;
  assert.deepEqual(session.unresolved(), []);
  assert.equal(byLocation(session, path.join(dir, "missing.md")).state, "analysed");
  session.close();
});

test("a change on disk is one change; identical bytes are none", async () => {
  const dir = await directory({ "a.md": '@include{src="b.md"}\n', "b.md": "one\n" });
  const { session, seen, next } = await open(dir);
  const b = byLocation(session, path.join(dir, "b.md"));

  const changed = next();
  await fs.writeFile(path.join(dir, "b.md"), "two\n");
  await changed;
  assert.deepEqual(seen, [{ added: [], removed: [], changed: [b.id] }]);

  await fs.writeFile(path.join(dir, "b.md"), "two\n");
  await sleep(300);
  assert.equal(seen.length, 1);
  session.close();
});

test("a write-then-rename save is one change", async () => {
  const dir = await directory({ "a.md": '@include{src="b.md"}\n', "b.md": "one\n" });
  const { session, seen, next } = await open(dir);
  const b = byLocation(session, path.join(dir, "b.md"));

  const changed = next();
  await fs.writeFile(path.join(dir, "b.md.tmp"), "saved\n");
  await fs.rename(path.join(dir, "b.md.tmp"), path.join(dir, "b.md"));
  await changed;
  await sleep(300);
  assert.deepEqual(seen, [{ added: [], removed: [], changed: [b.id] }]);
  session.close();
});

test("canonicalize follows a symlink; a missing file has no identity", async () => {
  const dir = await directory({ "real.md": "" });
  await fs.symlink(path.join(dir, "real.md"), path.join(dir, "link.md"));
  const host = createNodeHost();
  assert.equal(await host.canonicalize(path.join(dir, "link.md")), path.join(dir, "real.md"));
  assert.equal(await host.canonicalize(path.join(dir, "missing.md")), undefined);
  const refused = await host.read(path.join(dir, "missing.md"));
  assert.equal(refused.ok, false);
});
