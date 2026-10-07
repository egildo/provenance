import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openSession } from "../src/index.ts";
import type { Change, Findings, Handler, Host, Session, Writer } from "../src/index.ts";
import { createMemoryHost } from "../src/memory.ts";
import { absorbed, byLocation, keyValue, tick, unhandled } from "./helpers.ts";

// The editing stage's first slice (specs/editing/spec.md). The file /w.conf is `a=1⏎b=2⏎`, 8 bytes,
// a's value at 2-3 and b's at 6-7; every expected value below is worked out by hand.

const W = "a=1\nb=2\n";
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

async function open(files: Record<string, string> = { "/w.conf": W }, extra: { writers?: readonly Writer[]; handlers?: readonly Handler[]; writable?: readonly string[] } = {}) {
  const memory = createMemoryHost(files);
  const session = await openSession({ host: memory, entry: Object.keys(files)[0] ?? "/w.conf", handlers: extra.handlers ?? [], writers: extra.writers ?? [keyValue], writable: extra.writable ?? ["/"] });
  return { memory, session };
}

const idOf = (session: Session, location: string) => byLocation(session, location).id;

test("case 7: staging at a path again replaces the edit; it never stacks", async () => {
  const { session } = await open();
  assert.deepEqual(await session.stage("/w.conf", "b", "3"), { ok: true });
  assert.deepEqual(await session.stage("/w.conf", "b", "4"), { ok: true });
  const index = session.index();
  assert.equal(index.length, 1);
  assert.deepEqual(index[0], { source: idOf(session, "/w.conf"), path: "b", value: "4", base: sha(bytes(W)), start: 6, end: 7, status: "staged" });
  const preview = await session.preview(idOf(session, "/w.conf"));
  assert.equal(text(preview?.bytes ?? new Uint8Array()), "a=1\nb=4\n");
  session.close();
});

test("case 8: edits are applied from the end backwards, every range against the base", async () => {
  const { session } = await open();
  await session.stage("/w.conf", "a", "77");
  await session.stage("/w.conf", "b", "3");
  assert.deepEqual(session.index().map(e => [e.path, e.start, e.end]), [["a", 2, 3], ["b", 6, 7]]);
  const preview = await session.preview(idOf(session, "/w.conf"));
  assert.equal(text(preview?.bytes ?? new Uint8Array()), "a=77\nb=3\n");
  assert.equal(preview?.bytes.length, 9);
  assert.equal(preview?.version, sha(bytes("a=77\nb=3\n")));
  session.close();
});

test("case 10: staging refuses, and never throws, what it cannot stage", async () => {
  const { session } = await open({ "/w.conf": W, "/other.txt": "x\n" });
  await session.addRoot("/other.txt");
  assert.deepEqual(await session.stage("/nowhere.conf", "a", "1"), { ok: false, reason: "not a source in the session's graph" });
  assert.deepEqual(await session.stage("/other.txt", "a", "1"), { ok: false, reason: "no writer claims /other.txt" });
  assert.deepEqual(await session.stage("/w.conf", "c", "1"), { ok: false, reason: "no key c" });
  assert.deepEqual(session.index(), []);
  session.close();
});

test("a source the host refused cannot be staged", async () => {
  const { session, memory } = await open({ "/w.conf": W, "/gone.conf": "a=1\n" });
  await session.addRoot("/gone.conf");
  memory.refuse("/gone.conf", "permission denied");
  await absorbed(session, "/w.conf");
  const result = await session.stage("/gone.conf", "a", "2");
  assert.equal(result.ok, false);
  session.close();
});

test("a disk the session has not absorbed yet cannot be staged against", async () => {
  const { session, memory } = await open();
  memory.write("/w.conf", "# note\na=1\nb=2\n");
  const result = await session.stage("/w.conf", "b", "3"); // the change event is still in flight
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /changed on disk/);
  session.close();
});

test("two staged edits whose ranges overlap are a writer bug, refused at staging", async () => {
  const overlapping: Writer = {
    claims: keyValue.claims,
    locate: keyValue.locate,
    write: (_bytes, path) => ({ ok: true, edit: { start: 2, end: path === "x" ? 3 : 4, bytes: bytes("Z") } }),
  };
  const { session } = await open({ "/w.conf": W }, { writers: [overlapping] });
  assert.deepEqual(await session.stage("/w.conf", "x", "1"), { ok: true });
  const result = await session.stage("/w.conf", "y", "1");
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /overlap/);
  assert.equal(session.index().length, 1);
  session.close();
});

test("a range outside the source is a writer bug and throws; nothing is staged", async () => {
  const wild: Writer = { ...keyValue, write: () => ({ ok: true, edit: { start: 2, end: 99, bytes: bytes("Z") } }) };
  const { session } = await open({ "/w.conf": W }, { writers: [wild] });
  await assert.rejects(session.stage("/w.conf", "a", "1"), RangeError);
  assert.deepEqual(session.index(), []);
  session.close();
});

test("a writer that throws rejects the call and leaves the index as it was", async () => {
  const writer: Writer = {
    ...keyValue,
    write(data, path, value) {
      if (path === "boom") throw new Error("writer broke");
      return keyValue.write(data, path, value);
    },
  };
  const { session } = await open({ "/w.conf": W }, { writers: [writer] });
  await session.stage("/w.conf", "a", "9");
  await assert.rejects(session.stage("/w.conf", "boom", "1"), /writer broke/);
  assert.deepEqual(session.index().map(e => e.path), ["a"]);
  assert.deepEqual(await session.stage("/w.conf", "b", "3"), { ok: true });
  session.close();
});

test("unstage drops one edit or every edit of a source, and the preview goes with the last", async () => {
  const { session } = await open();
  await session.stage("/w.conf", "a", "77");
  await session.stage("/w.conf", "b", "3");
  await session.unstage("/w.conf", "a");
  assert.deepEqual(session.index().map(e => e.path), ["b"]);
  assert.equal(text((await session.preview(idOf(session, "/w.conf")))?.bytes ?? new Uint8Array()), "a=1\nb=3\n");
  await session.unstage("/w.conf");
  assert.deepEqual(session.index(), []);
  assert.equal(await session.preview(idOf(session, "/w.conf")), undefined);
  session.close();
});

test("a preview is analysed like any version, and held while its edits are staged", async () => {
  let calls = 0;
  const handler: Handler = {
    claims: location => location.endsWith(".conf"),
    analyze(): Findings {
      calls++;
      return { requests: [] };
    },
  };
  const { session } = await open({ "/w.conf": W }, { handlers: [handler] });
  assert.equal(calls, 1); // the base
  await session.stage("/w.conf", "b", "3");
  const id = idOf(session, "/w.conf");
  await session.preview(id);
  assert.equal(calls, 2); // the preview's version
  // Another session's work ends, and sweeps the handler's findings: the staged preview is held.
  const bystander = await openSession({ host: createMemoryHost({ "/x.conf": "x=1\n" }), entry: "/x.conf", handlers: [handler] });
  assert.equal(calls, 3); // x.conf
  await session.preview(id);
  assert.equal(calls, 3);
  // Unstaged, nobody holds it: staging the same edit again and previewing analyses it again.
  await session.unstage("/w.conf");
  await session.stage("/w.conf", "b", "3");
  await session.preview(id);
  assert.equal(calls, 4);
  bystander.close();
  session.close();
});

// Rebase (FR-008). The disk moves under a staged edit; the writer finds the path again.

function heard(session: Session): Change[] {
  const changes: Change[] = [];
  session.onChange(change => changes.push(change));
  return changes;
}

test("case 3: a disk change elsewhere moves the edit to where its path now is", async () => {
  const { session, memory } = await open();
  await session.stage("/w.conf", "b", "3");
  const changes = heard(session);
  const id = idOf(session, "/w.conf");
  memory.write("/w.conf", "# note\na=1\nb=2\n"); // "# note⏎" is 7 bytes, so b's value moves from 6-7 to 13-14
  await absorbed(session, "/w.conf");
  assert.deepEqual(session.index(), [{ source: id, path: "b", value: "3", base: sha(bytes("# note\na=1\nb=2\n")), start: 13, end: 14, status: "staged" }]);
  assert.deepEqual(changes, [{ added: [], removed: [], changed: [id], edits: [{ source: id, path: "b", outcome: "moved", start: 13, end: 14 }] }]);
  assert.equal(text((await session.preview(id))?.bytes ?? new Uint8Array()), "# note\na=1\nb=3\n");
  session.close();
});

test("case 4: the same value changed on disk is overridden, carrying the disk's bytes, and reported", async () => {
  const { session, memory } = await open();
  await session.stage("/w.conf", "b", "3");
  const changes = heard(session);
  const id = idOf(session, "/w.conf");
  memory.write("/w.conf", "a=1\nb=5\n");
  await absorbed(session, "/w.conf");
  assert.deepEqual(session.index(), [{ source: id, path: "b", value: "3", base: sha(bytes("a=1\nb=5\n")), start: 6, end: 7, status: "overrides", disk: bytes("5") }]);
  assert.deepEqual(changes, [{ added: [], removed: [], changed: [id], edits: [{ source: id, path: "b", outcome: "overrides", start: 6, end: 7, disk: bytes("5") }] }]);
  session.close();
});

test("case 5: a disk change to another value is kept, and says nothing about the edit", async () => {
  const { session, memory } = await open();
  await session.stage("/w.conf", "b", "3");
  const changes = heard(session);
  const id = idOf(session, "/w.conf");
  memory.write("/w.conf", "a=9\nb=2\n");
  await absorbed(session, "/w.conf");
  assert.deepEqual(session.index(), [{ source: id, path: "b", value: "3", base: sha(bytes("a=9\nb=2\n")), start: 6, end: 7, status: "staged" }]);
  assert.deepEqual(changes, [{ added: [], removed: [], changed: [id] }]);
  session.close();
});

test("case 6: a path gone from the new version is conflicted: dropped, and reported", async () => {
  const { session, memory } = await open();
  await session.stage("/w.conf", "b", "3");
  const changes = heard(session);
  const id = idOf(session, "/w.conf");
  memory.write("/w.conf", "a=1\n");
  await absorbed(session, "/w.conf");
  assert.deepEqual(session.index(), []);
  assert.deepEqual(changes, [{ added: [], removed: [], changed: [id], edits: [{ source: id, path: "b", outcome: "conflicted" }] }]);
  assert.equal(await session.preview(id), undefined);
  session.close();
});

test("a source that vanishes conflicts every edit it had", async () => {
  const { session, memory } = await open({ "/w.conf": W });
  await session.stage("/w.conf", "a", "9");
  await session.stage("/w.conf", "b", "3");
  const changes = heard(session);
  memory.remove("/w.conf");
  await absorbed(session, "/w.conf");
  assert.deepEqual(session.index(), []);
  assert.deepEqual(changes.flatMap(c => c.edits ?? []).map(e => [e.path, e.outcome]), [["a", "conflicted"], ["b", "conflicted"]]);
  session.close();
});

test("an overriding edit stays overriding through a later change that leaves the value alone", async () => {
  const { session, memory } = await open();
  await session.stage("/w.conf", "b", "3");
  memory.write("/w.conf", "a=1\nb=5\n");
  await absorbed(session, "/w.conf");
  memory.write("/w.conf", "a=9\nb=5\n");
  await absorbed(session, "/w.conf");
  assert.deepEqual(session.index().map(e => [e.status, text(e.disk ?? new Uint8Array())]), [["overrides", "5"]]);
  // Staging the path again is a new edit against the current base, and overrides nothing.
  await session.stage("/w.conf", "b", "4");
  assert.deepEqual(session.index().map(e => e.status), ["staged"]);
  session.close();
});

test("a rolled-back batch leaves the staged edits where they were", async () => {
  const throwing: Handler = {
    claims: location => location.endsWith(".md"),
    analyze(source) {
      if (source.includes("BOOM")) throw new Error("handler broke");
      return { requests: [] };
    },
  };
  const { session, memory } = await open({ "/w.conf": W, "/n.md": "fine\n" }, { handlers: [throwing] });
  await session.addRoot("/n.md");
  await session.stage("/w.conf", "b", "3");
  const before = session.index();
  const seen = await unhandled(async () => {
    memory.write("/w.conf", "# note\na=1\nb=2\n"); // rebased first ...
    memory.write("/n.md", "BOOM\n"); // ... then the batch throws, and is rolled back
    await tick();
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(session.index(), before);
  session.close();
});

test("a read pass that ends on newer bytes rebases the edits too", async () => {
  const memory = createMemoryHost({ "/w.conf": W });
  const host: Host = { ...memory, watch: () => ({ set: () => undefined, close: () => undefined }) }; // no watcher: only the pass can notice
  const session = await openSession({ host, entry: "/w.conf", handlers: [], writers: [keyValue], writable: ["/"] });
  await session.stage("/w.conf", "b", "3");
  memory.write("/w.conf", "# note\na=1\nb=2\n");
  const pass = session.read();
  await pass.host.read("/w.conf");
  await pass.end();
  assert.deepEqual(session.index().map(e => [e.start, e.end]), [[13, 14]]);
  session.close();
});
