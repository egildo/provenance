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

// Deliberately changed in round 2 (it used to pin a refusal): staging never refuses because the disk moved.
test("a disk the session has not absorbed yet is staged against anyway, and the rebase moves the edit", async () => {
  const { session, memory } = await open();
  memory.write("/w.conf", "# note\na=1\nb=2\n");
  assert.deepEqual(await session.stage("/w.conf", "b", "3"), { ok: true }); // the change event is still in flight
  assert.deepEqual(session.index().map(e => [e.start, e.end, e.base]), [[6, 7, sha(bytes(W))]]); // against the base the session holds
  await absorbed(session, "/w.conf");
  assert.deepEqual(session.index().map(e => [e.start, e.end, e.base]), [[13, 14, sha(bytes("# note\na=1\nb=2\n"))]]);
  await session.commit();
  assert.equal(await read(memory, "/w.conf"), "# note\na=1\nb=3\n");
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

// Commit (FR-009, FR-010).

/** A host that records the writes it is asked to make, and can be made to fail them or to lack the verb. */
function spied(memory: ReturnType<typeof createMemoryHost>, options: { fail?: string; noWrite?: boolean } = {}) {
  const writes: [string, string][] = [];
  const host: Host = {
    ...memory,
    ...(options.noWrite ? { write: undefined } : {}),
    ...(options.noWrite
      ? {}
      : {
          async write(location: string, data: Uint8Array) {
            writes.push([location, text(data)]);
            return options.fail === undefined ? memory.write(location, data) : { ok: false as const, reason: options.fail };
          },
        }),
  };
  return { host, writes };
}

async function openOn(host: Host, extra: { writable?: readonly string[]; handlers?: readonly Handler[]; entry?: string } = {}) {
  return openSession({ host, entry: extra.entry ?? "/w.conf", handlers: extra.handlers ?? [], writers: [keyValue], writable: extra.writable ?? ["/"] });
}

const read = async (memory: Host, location: string) => {
  const result = await memory.read(location);
  return result.ok ? text(result.bytes) : result.reason;
};

test("case 1: a staged edit is written, only its value moves, and the session reads the new version", async () => {
  const memory = createMemoryHost({ "/w.conf": W });
  const { host, writes } = spied(memory);
  const session = await openOn(host);
  const id = idOf(session, "/w.conf");
  await session.stage("/w.conf", "b", "3");
  const changes = heard(session);
  const report = await session.commit();
  assert.deepEqual(report, { sources: [{ source: id, location: "/w.conf", outcome: "written", version: sha(bytes("a=1\nb=3\n")), edits: [{ path: "b", outcome: "written" }] }] });
  assert.deepEqual(writes, [["/w.conf", "a=1\nb=3\n"]]);
  assert.equal(await read(memory, "/w.conf"), "a=1\nb=3\n");
  assert.deepEqual(session.index(), []);
  assert.deepEqual(changes, [{ added: [], removed: [], changed: [id] }]);
  const source = byLocation(session, "/w.conf");
  assert.equal(source.state === "leaf" && source.version, sha(bytes("a=1\nb=3\n")));
  session.close();
});

test("FR-010: the session absorbs its own write by re-analysing, once", async () => {
  let calls = 0;
  const handler: Handler = { claims: l => l.endsWith(".conf"), analyze: () => (calls++, { requests: [] }) };
  const memory = createMemoryHost({ "/w.conf": W });
  const session = await openOn(memory, { handlers: [handler] });
  assert.equal(calls, 1);
  await session.stage("/w.conf", "b", "3");
  await session.commit();
  assert.equal(calls, 2);
  await tick(); // the host's own change event for the write arrives, and finds the version already held
  await absorbed(session, "/w.conf");
  assert.equal(calls, 2);
  session.close();
});

test("case 2 and 12: nothing staged, nothing written; and a second commit writes nothing", async () => {
  const memory = createMemoryHost({ "/w.conf": W });
  const { host, writes } = spied(memory);
  const session = await openOn(host);
  assert.deepEqual(await session.commit(), { sources: [] });
  assert.deepEqual(writes, []);
  await session.stage("/w.conf", "b", "3");
  await session.commit();
  assert.equal(writes.length, 1);
  assert.deepEqual(await session.commit(), { sources: [] });
  assert.equal(writes.length, 1);
  session.close();
});

test("case 3: an edit rebased onto a changed disk is written where its path now is", async () => {
  const memory = createMemoryHost({ "/w.conf": W });
  const session = await openOn(memory);
  await session.stage("/w.conf", "b", "3");
  memory.write("/w.conf", "# note\na=1\nb=2\n");
  await absorbed(session, "/w.conf");
  const report = await session.commit();
  assert.deepEqual(report.sources.map(s => [s.outcome, s.edits]), [["written", [{ path: "b", outcome: "written" }]]]);
  assert.equal(await read(memory, "/w.conf"), "# note\na=1\nb=3\n");
  session.close();
});

test("a commit rebases first when the disk moved and the session has not heard yet", async () => {
  const memory = createMemoryHost({ "/w.conf": W });
  const session = await openOn(memory);
  const id = idOf(session, "/w.conf");
  await session.stage("/w.conf", "b", "3");
  const changes = heard(session);
  memory.write("/w.conf", "# note\na=1\nb=2\n");
  const report = await session.commit(); // queued before the change event is absorbed
  assert.equal(report.sources[0]?.outcome, "written");
  assert.equal(await read(memory, "/w.conf"), "# note\na=1\nb=3\n");
  assert.deepEqual(changes[0]?.edits, [{ source: id, path: "b", outcome: "moved", start: 13, end: 14 }]);
  session.close();
});

test("case 4: the last to commit wins, per value: the disk's bytes are replaced and the report says so", async () => {
  const memory = createMemoryHost({ "/w.conf": W });
  const session = await openOn(memory);
  await session.stage("/w.conf", "b", "3");
  memory.write("/w.conf", "a=1\nb=5\n");
  await absorbed(session, "/w.conf");
  const report = await session.commit();
  assert.deepEqual(report.sources[0]?.edits, [{ path: "b", outcome: "overrode", disk: bytes("5") }]);
  assert.equal(await read(memory, "/w.conf"), "a=1\nb=3\n");
  session.close();
});

test("case 4, unabsorbed: a commit that finds the value changed on disk overrides it and says so", async () => {
  const memory = createMemoryHost({ "/w.conf": W });
  const session = await openOn(memory);
  await session.stage("/w.conf", "b", "3");
  memory.write("/w.conf", "a=1\nb=5\n");
  const report = await session.commit();
  assert.deepEqual(report.sources[0]?.edits, [{ path: "b", outcome: "overrode", disk: bytes("5") }]);
  assert.equal(await read(memory, "/w.conf"), "a=1\nb=3\n");
  session.close();
});

test("case 5: a disk change to another value is kept", async () => {
  const memory = createMemoryHost({ "/w.conf": W });
  const session = await openOn(memory);
  await session.stage("/w.conf", "b", "3");
  memory.write("/w.conf", "a=9\nb=2\n");
  await absorbed(session, "/w.conf");
  await session.commit();
  assert.equal(await read(memory, "/w.conf"), "a=9\nb=3\n");
  session.close();
});

test("case 6: a conflicted edit is never written", async () => {
  const memory = createMemoryHost({ "/w.conf": W });
  const { host, writes } = spied(memory);
  const session = await openOn(host);
  await session.stage("/w.conf", "b", "3");
  memory.write("/w.conf", "a=1\n");
  await absorbed(session, "/w.conf");
  assert.deepEqual(await session.commit(), { sources: [] });
  assert.deepEqual(writes, []);
  session.close();
});

test("case 6, unabsorbed: a commit that finds the path gone reports the source conflicted and writes nothing", async () => {
  const memory = createMemoryHost({ "/w.conf": W });
  const { host, writes } = spied(memory);
  const session = await openOn(host);
  const id = idOf(session, "/w.conf");
  await session.stage("/w.conf", "b", "3");
  memory.write("/w.conf", "a=1\n");
  const report = await session.commit();
  assert.deepEqual(report, { sources: [{ source: id, location: "/w.conf", outcome: "conflicted", edits: [{ path: "b", outcome: "conflicted" }] }] });
  assert.deepEqual(writes, []);
  assert.deepEqual(session.index(), []);
  session.close();
});

test("case 8: two edits in one source are both written, and nothing else moves", async () => {
  const memory = createMemoryHost({ "/w.conf": W });
  const session = await openOn(memory);
  await session.stage("/w.conf", "a", "77");
  await session.stage("/w.conf", "b", "3");
  await session.commit();
  const disk = await memory.read("/w.conf");
  assert.equal(disk.ok && text(disk.bytes), "a=77\nb=3\n");
  assert.equal(disk.ok && disk.bytes.length, 9);
  session.close();
});

test("case 9: with no writable root, a commit is refused and the edit is kept", async () => {
  const memory = createMemoryHost({ "/w.conf": W });
  const { host, writes } = spied(memory);
  const session = await openSession({ host, entry: "/w.conf", handlers: [], writers: [keyValue] }); // `writable` absent
  const id = idOf(session, "/w.conf");
  await session.stage("/w.conf", "b", "3");
  const report = await session.commit();
  assert.deepEqual(report, { sources: [{ source: id, location: "/w.conf", outcome: "refused", reason: "/w.conf is outside every writable root", edits: [] }] });
  assert.deepEqual(writes, []);
  assert.equal(await read(memory, "/w.conf"), W);
  assert.equal(session.index().length, 1);
  session.close();
});

test("case 11: a host that fails the write: the report says why, and the edit is kept", async () => {
  const memory = createMemoryHost({ "/w.conf": W });
  const { host } = spied(memory, { fail: "disk full" });
  const session = await openOn(host);
  const id = idOf(session, "/w.conf");
  await session.stage("/w.conf", "b", "3");
  const report = await session.commit();
  assert.deepEqual(report, { sources: [{ source: id, location: "/w.conf", outcome: "failed", reason: "disk full", edits: [] }] });
  assert.equal(await read(memory, "/w.conf"), W);
  assert.equal(session.index().length, 1);
  session.close();
});

test("a host without a write verb can stage and preview, and its commit is refused", async () => {
  const memory = createMemoryHost({ "/w.conf": W });
  const { host } = spied(memory, { noWrite: true });
  const session = await openOn(host);
  await session.stage("/w.conf", "b", "3");
  assert.equal(text((await session.preview(idOf(session, "/w.conf")))?.bytes ?? new Uint8Array()), "a=1\nb=3\n");
  const report = await session.commit();
  assert.equal(report.sources[0]?.outcome, "refused");
  assert.match(report.sources[0]?.reason ?? "", /cannot write/);
  assert.equal(session.index().length, 1);
  session.close();
});

test("case 13: the sandbox is per source, judged on whole path segments", async () => {
  const memory = createMemoryHost({ "/d/w.conf": W, "/x/x.conf": "a=1\n", "/dd/y.conf": "a=1\n" });
  const { host, writes } = spied(memory);
  const session = await openSession({ host, entry: "/d/w.conf", handlers: [], writers: [keyValue], writable: ["/d"] });
  await session.addRoot("/x/x.conf");
  await session.addRoot("/dd/y.conf");
  await session.stage("/d/w.conf", "b", "3");
  await session.stage("/x/x.conf", "a", "2");
  await session.stage("/dd/y.conf", "a", "2"); // "/dd" is not under "/d"
  const report = await session.commit();
  assert.deepEqual(report.sources.map(s => [s.location, s.outcome]), [["/d/w.conf", "written"], ["/x/x.conf", "refused"], ["/dd/y.conf", "refused"]]);
  assert.deepEqual(writes, [["/d/w.conf", "a=1\nb=3\n"]]);
  assert.deepEqual(session.index().map(e => e.path), ["a", "a"]); // the refused ones are kept
  session.close();
});

test("a failure on one source does not stop the others; the report says what landed", async () => {
  const memory = createMemoryHost({ "/w.conf": W, "/v.conf": "a=1\n" });
  const writes: string[] = [];
  const host: Host = {
    ...memory,
    async write(location, data) {
      writes.push(location);
      return location === "/w.conf" ? { ok: false, reason: "disk full" } : memory.write(location, data);
    },
  };
  const session = await openOn(host);
  await session.addRoot("/v.conf");
  await session.stage("/w.conf", "b", "3");
  await session.stage("/v.conf", "a", "2");
  const report = await session.commit();
  assert.deepEqual(report.sources.map(s => [s.location, s.outcome]), [["/w.conf", "failed"], ["/v.conf", "written"]]);
  assert.deepEqual(writes, ["/w.conf", "/v.conf"]);
  assert.equal(await read(memory, "/v.conf"), "a=2\n");
  assert.deepEqual(session.index().map(e => e.path), ["b"]);
  session.close();
});

test("a throw while committing rejects the call and leaves the index and the disk as they were", async () => {
  let broken = false;
  const writer: Writer = {
    ...keyValue,
    locate(data, path) {
      if (broken) throw new Error("writer broke");
      return keyValue.locate(data, path);
    },
  };
  const memory = createMemoryHost({ "/w.conf": W });
  const spy = spied(memory);
  const { writes } = spy;
  const host: Host = { ...spy.host, watch: () => ({ set: () => undefined, close: () => undefined }) }; // only the commit meets the new disk
  const session = await openSession({ host, entry: "/w.conf", handlers: [], writers: [writer], writable: ["/"] });
  await session.stage("/w.conf", "b", "3");
  const before = session.index();
  broken = true;
  memory.write("/w.conf", "# note\na=1\nb=2\n");
  await assert.rejects(session.commit(), /writer broke/);
  assert.deepEqual(session.index(), before);
  assert.deepEqual(writes, []);
  session.close();
});

// Round 2: a disk write cannot be rolled back, so a commit's writes are kept after a throw (it used to
// restore the edits of a file that was already written).
test("a handler that throws on the written text rejects the commit, and the file stays committed", async () => {
  const throwing: Handler = {
    claims: location => location.endsWith(".conf"),
    analyze(source) {
      if (source.includes("BOOM")) throw new Error("handler broke");
      return { requests: [] };
    },
  };
  const memory = createMemoryHost({ "/w.conf": W, "/v.conf": "a=1\n", "/u.conf": "a=1\n" });
  const { host, writes } = spied(memory);
  const quiet: Host = { ...host, watch: () => ({ set: () => undefined, close: () => undefined }) };
  const session = await openOn(quiet, { handlers: [throwing] });
  await session.addRoot("/v.conf");
  await session.addRoot("/u.conf");
  await session.stage("/v.conf", "a", "2");
  await session.stage("/w.conf", "b", "BOOM");
  await session.stage("/u.conf", "a", "3"); // after the throwing one: never reached
  await assert.rejects(session.commit(), /handler broke/);
  assert.equal(await read(memory, "/v.conf"), "a=2\n");
  assert.equal(await read(memory, "/w.conf"), "a=1\nb=BOOM\n");
  assert.equal(await read(memory, "/u.conf"), "a=1\n");
  // The written sources' edits are out of the index; the one never reached is still staged.
  assert.deepEqual(session.index().map(e => [e.path, e.value]), [["a", "3"]]);
  // A second commit writes only that one, and nothing is reported as overridden.
  writes.length = 0;
  const report = await session.commit();
  assert.deepEqual(writes, [["/u.conf", "a=3\n"]]);
  assert.deepEqual(report.sources.map(r => [r.location, r.outcome, r.edits.map(e => e.outcome)]), [["/u.conf", "written", ["written"]]]);
  session.close();
});

// Round 2: a rebase writes the value again on the new bytes.
test("a rebase writes the value again, because its spelling can depend on its neighbours", async () => {
  // A test writer that quotes a value when the previous line ends with a comma.
  const quoting: Writer = {
    ...keyValue,
    write(data, path, value) {
      const found = keyValue.locate(data, path);
      if (!found.ok) return found;
      const lines = text(data.slice(0, found.start)).split("\n");
      const quoted = (lines[lines.length - 2] ?? "").endsWith(",");
      return { ok: true, edit: { start: found.start, end: found.end, bytes: bytes(quoted ? `"${String(value)}"` : String(value)) } };
    },
  };
  const memory = createMemoryHost({ "/w.conf": W });
  const session = await openSession({ host: memory, entry: "/w.conf", handlers: [], writers: [quoting], writable: ["/"] });
  await session.stage("/w.conf", "b", "3");
  assert.equal(text((await session.preview(idOf(session, "/w.conf")))?.bytes ?? new Uint8Array()), "a=1\nb=3\n");
  memory.write("/w.conf", "a=1,\nb=2\n"); // "a=1,⏎" is 5 bytes, so b's value moves to 7-8, and its neighbour now ends with a comma
  await absorbed(session, "/w.conf");
  assert.deepEqual(session.index().map(e => [e.start, e.end]), [[7, 8]]);
  assert.equal(text((await session.preview(idOf(session, "/w.conf")))?.bytes ?? new Uint8Array()), 'a=1,\nb="3"\n');
  await session.commit();
  assert.equal(await read(memory, "/w.conf"), 'a=1,\nb="3"\n');
  session.close();
});

// Joining FR-002 (editing FR-008 as amended): a rebase that keeps the range but changes the bytes is reported.
test("a rebase that respells an edit without moving it says so", async () => {
  const quoting: Writer = {
    ...keyValue,
    write(data, path, value) {
      const found = keyValue.locate(data, path);
      if (!found.ok) return found;
      const lines = text(data.slice(0, found.start)).split("\n");
      const quoted = (lines[lines.length - 2] ?? "").endsWith(",");
      return { ok: true, edit: { start: found.start, end: found.end, bytes: bytes(quoted ? `"${String(value)}"` : String(value)) } };
    },
  };
  const memory = createMemoryHost({ "/w.conf": W });
  const session = await openSession({ host: memory, entry: "/w.conf", handlers: [], writers: [quoting], writable: ["/"] });
  const id = idOf(session, "/w.conf");
  await session.stage("/w.conf", "b", "3");
  const changes = heard(session);
  memory.write("/w.conf", "a=,\nb=2\n"); // "a=1⏎" and "a=,⏎" are both 4 bytes: b's value stays at 6-7, but its neighbour now ends in a comma
  await absorbed(session, "/w.conf");
  assert.deepEqual(session.index().map(e => [e.start, e.end, e.status]), [[6, 7, "staged"]]);
  assert.deepEqual(changes, [{ added: [], removed: [], changed: [id], edits: [{ source: id, path: "b", outcome: "respelled", start: 6, end: 7 }] }]);
  assert.equal(text((await session.preview(id))?.bytes ?? new Uint8Array()), 'a=,\nb="3"\n');
  session.close();
});

test("a value is a scalar: an object is a compile error, and the scalars compile", async () => {
  const { session } = await open();
  // @ts-expect-error an object is not an EditValue
  await session.stage("/w.conf", "a", { not: "a scalar" });
  await session.stage("/w.conf", "a", "1");
  await session.stage("/w.conf", "a", 1);
  await session.stage("/w.conf", "a", 1n);
  await session.stage("/w.conf", "a", true);
  await session.stage("/w.conf", "a", null);
  session.close();
});
