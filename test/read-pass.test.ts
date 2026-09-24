import { test } from "node:test";
import assert from "node:assert/strict";
import { openSession } from "../src/index.ts";
import type { Change, Host, Session } from "../src/index.ts";
import { createMemoryHost } from "../src/memory.ts";
import { absorbed, byLocation, include } from "./helpers.ts";

// specs/read-passes/spec.md, from egildo/provenance#1.

/** A memory host that counts how often the session hands it a watched set, and what it last was. */
function counted(files: Record<string, string>) {
  const memory = createMemoryHost(files);
  const seen = { sets: 0, watched: [] as readonly string[] };
  const host: Host = {
    ...memory,
    watch(onChange) {
      const inner = memory.watch(onChange);
      return { set: locations => ((seen.sets++, (seen.watched = locations)), inner.set(locations)), close: inner.close };
    },
  };
  return { memory, host, seen };
}

function record(session: Session): Change[] {
  const changes: Change[] = [];
  session.onChange(change => changes.push(change));
  return changes;
}

const locations = (session: Session) => session.sources().map(s => s.location).sort();

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
}

test("a pass replaces its predecessor: what the render stops reading leaves", async () => {
  const { host, seen } = counted({ "/e.md": "", "/a.yaml": "a", "/b.yaml": "b", "/c.yaml": "c" });
  const session = await openSession({ host, entry: "/e.md", handlers: [include] });
  const changes = record(session);

  const first = session.read("render");
  await first.host.read("/a.yaml");
  await first.host.read("/b.yaml");
  await first.end();
  assert.deepEqual(locations(session), ["/a.yaml", "/b.yaml", "/e.md"]);

  const second = session.read("render");
  await second.host.read("/a.yaml");
  await second.host.read("/c.yaml");
  await second.end();
  assert.deepEqual(locations(session), ["/a.yaml", "/c.yaml", "/e.md"]);
  assert.ok(!seen.watched.includes("/b.yaml") && seen.watched.includes("/c.yaml"));
  assert.equal(changes.length, 2);
  assert.equal(changes[1].added.length, 1);
  assert.equal(changes[1].removed.length, 1);
  session.close();
});

test("a pass ended after its reader threw still replaces its predecessor", async () => {
  const { host } = counted({ "/e.md": "", "/a.yaml": "a", "/b.yaml": "b" });
  const session = await openSession({ host, entry: "/e.md", handlers: [] });
  const first = session.read();
  await first.host.read("/a.yaml");
  await first.end();

  const second = session.read();
  try {
    await second.host.read("/b.yaml");
    throw new Error("the render failed");
  } catch {
    // The embedder reports the render error; the pass still ends.
  } finally {
    await second.end();
  }
  assert.deepEqual(locations(session), ["/b.yaml", "/e.md"]);
  session.close();
});

test("roots the embedder added are never touched by a pass", async () => {
  const { host } = counted({ "/e.md": "", "/style.css": "", "/a.yaml": "" });
  const session = await openSession({ host, entry: "/e.md", handlers: [] });
  await session.addRoot("/style.css");
  const pass = session.read();
  await pass.host.read("/a.yaml");
  await pass.end();
  await session.read().end();
  assert.deepEqual(locations(session), ["/e.md", "/style.css"]);
  session.close();
});

test("a failed read is watched, and its file appearing is reported once as changed", async () => {
  const { memory, host } = counted({ "/e.md": "" });
  const session = await openSession({ host, entry: "/e.md", handlers: [] });
  const pass = session.read();
  assert.equal((await pass.host.read("/house.yaml")).ok, false);
  const manifest = await pass.end();
  assert.deepEqual(manifest.missing, ["/house.yaml"]);
  const house = byLocation(session, "/house.yaml");
  assert.equal(house.state, "refused");

  const changes = record(session);
  memory.write("/house.yaml", "theme: dark\n");
  await absorbed(session, "/e.md");
  assert.deepEqual(changes, [{ added: [], removed: [], changed: [house.id] }]);

  const next = session.read();
  assert.equal((await next.host.read("/house.yaml")).ok, true);
  assert.deepEqual((await next.end()).missing, []);
  session.close();
});

test("an existence miss is watched the same way", async () => {
  const { memory, host } = counted({ "/e.md": "" });
  const session = await openSession({ host, entry: "/e.md", handlers: [] });
  const pass = session.read();
  assert.equal(await pass.host.canonicalize("/venue/beltype.config.yaml"), undefined);
  await pass.end();

  const changes = record(session);
  memory.write("/venue/beltype.config.yaml", "x: 1\n");
  await absorbed(session, "/e.md");
  assert.deepEqual(changes, [{ added: [], removed: [], changed: [byLocation(session, "/venue/beltype.config.yaml").id] }]);
  session.close();
});

test("a pass reading 40 files settles once, and no read waits on session work", async () => {
  const files: Record<string, string> = { "/e.md": "" };
  for (let k = 0; k < 40; k++) files[`/f${k}.yaml`] = `${k}`;
  const { host, seen } = counted(files);
  const session = await openSession({ host, entry: "/e.md", handlers: [] });

  // Hold the session busy on a read that waits for a gate.
  let open: () => void = () => undefined;
  const gate = new Promise<void>(resolve => (open = resolve));
  const slow: Host = { ...host, read: async location => (location === "/slow.md" ? (await gate, host.read("/e.md")) : host.read(location)) };
  const busy = await openSession({ host: slow, entry: "/e.md", handlers: [] });
  const queued = busy.addRoot("/slow.md");
  const quick = busy.read();
  assert.equal((await quick.host.read("/f0.yaml")).ok, true);
  open();
  await queued;
  await quick.end();
  busy.close();

  const before = seen.sets;
  const pass = session.read();
  for (let k = 0; k < 40; k++) await pass.host.read(`/f${k}.yaml`);
  assert.equal(seen.sets, before);
  await pass.end();
  assert.equal(seen.sets, before + 1);
  assert.equal(session.sources().length, 41);
  session.close();
});

test("the manifest names the bytes the render was handed, and a later rewrite is a change", async () => {
  const { memory, host } = counted({ "/e.md": "", "/a.yaml": "old" });
  const session = await openSession({ host, entry: "/e.md", handlers: [] });
  const changes = record(session);
  const pass = session.read();
  await pass.host.read("/a.yaml");
  memory.write("/a.yaml", "new");
  const manifest = await pass.end();

  const a = byLocation(session, "/a.yaml");
  assert.deepEqual(manifest.read, [{ source: a.id, version: await sha256("old") }]);
  assert.equal(a.state === "leaf" && a.version, await sha256("new"));
  assert.deepEqual(changes, [{ added: [], removed: [], changed: [a.id] }]);
  session.close();
});

test("a newer pass with the same label discards the unfinished one", async () => {
  const { host } = counted({ "/e.md": "", "/a.yaml": "", "/b.yaml": "" });
  const session = await openSession({ host, entry: "/e.md", handlers: [] });
  const stale = session.read("render");
  await stale.host.read("/a.yaml");
  const fresh = session.read("render");
  await fresh.host.read("/b.yaml");
  await fresh.end();
  const manifest = await stale.end();
  assert.equal(manifest.read.length, 1);
  assert.deepEqual(locations(session), ["/b.yaml", "/e.md"]);
  session.close();
});

test("passes with different labels keep their own roots", async () => {
  const { host } = counted({ "/e.md": "", "/a.yaml": "", "/b.yaml": "" });
  const session = await openSession({ host, entry: "/e.md", handlers: [] });
  const one = session.read("render");
  await one.host.read("/a.yaml");
  await one.end();
  const two = session.read("editor");
  await two.host.read("/b.yaml");
  await two.end();
  assert.deepEqual(locations(session), ["/a.yaml", "/b.yaml", "/e.md"]);
  session.close();
});

test("a noted code module is read by the pass, and leaves when a pass stops noting it", async () => {
  const { host } = counted({ "/e.md": "", "/plugin.js": "export default 1" });
  const session = await openSession({ host, entry: "/e.md", handlers: [] });
  const pass = session.read();
  pass.note("/plugin.js");
  pass.note("/gone.js");
  const manifest = await pass.end();
  const plugin = byLocation(session, "/plugin.js");
  assert.deepEqual(manifest.read, [{ source: plugin.id, version: await sha256("export default 1") }]);
  assert.deepEqual(manifest.missing, ["/gone.js"]);

  await session.read().end();
  assert.deepEqual(locations(session), ["/e.md"]);
  session.close();
});

test("end() after close() returns the manifest and watches nothing", async () => {
  const { host, seen } = counted({ "/e.md": "", "/a.yaml": "" });
  const session = await openSession({ host, entry: "/e.md", handlers: [] });
  const pass = session.read();
  await pass.host.read("/a.yaml");
  session.close();
  const sets = seen.sets;
  const manifest = await pass.end();
  assert.equal(manifest.read.length, 1);
  assert.equal(seen.sets, sets);
});
