import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { openSession } from "../src/index.ts";
import type { Change, Host, HostWriteResult, Session, Writer } from "../src/index.ts";
import { createMemoryHost } from "../src/memory.ts";
import { createNodeHost } from "../src/node.ts";
import { byLocation, closing, keyValue, scratch } from "./helpers.ts";

// Atomic commit (specs/atomic-commit/spec.md): a commit lands every staged source, or none. Files are
// `.conf` key=value files (helpers.ts): A = `a=1⏎b=2⏎` (a's value at 2-3), B = `c=1⏎d=2⏎` (d's value at 6-7),
// C = `e=1⏎`. Every expected byte string below is worked out by hand.

const A = "a=1\nb=2\n";
const B = "c=1\nd=2\n";
const C = "e=1\n";
const A9 = "a=9\nb=2\n"; // A with a set to 9
const B8 = "c=1\nd=8\n"; // B with d set to 8
const C2 = "e=2\n";
const bytes = (text: string) => new TextEncoder().encode(text);
const sha = (text: string) => createHash("sha256").update(bytes(text)).digest("hex");
const read = async (memory: ReturnType<typeof createMemoryHost>, location: string) => {
  const r = await memory.read(location);
  assert.ok(r.ok);
  return new TextDecoder().decode(r.bytes);
};

type Memory = ReturnType<typeof createMemoryHost>;

/**
 * A host over `memory` that records the session's own writes and lets a test decide each one. `quiet` stops the
 * watcher, so the commit is what meets a disk that moved.
 */
function wrapped(memory: Memory, options: { quiet?: boolean; onWrite?: (location: string, text: string, nth: number) => Promise<HostWriteResult | undefined> | HostWriteResult | undefined; onRead?: (location: string) => string | undefined } = {}) {
  const writes: [string, string][] = [];
  const host: Host = {
    ...memory,
    ...(options.quiet ? { watch: () => ({ set: () => undefined, close: () => undefined }) } : {}),
    async read(location) {
      const reason = options.onRead?.(location);
      return reason === undefined ? memory.read(location) : { ok: false, reason };
    },
    async write(location, data) {
      const body = new TextDecoder().decode(data);
      writes.push([location, body]);
      const verdict = await options.onWrite?.(location, body, writes.length);
      if (verdict) return verdict;
      await memory.write(location, data);
      return { ok: true };
    },
  };
  return { host, writes };
}

async function twoOn(host: Host, memory: Memory, files: string[], writers: readonly Writer[] = [keyValue], writable: readonly string[] = ["/"]) {
  const session = await openSession({ host, entry: files[0] ?? "/a.conf", handlers: [], writers, writable });
  for (const file of files.slice(1)) await session.addRoot(file);
  void memory;
  return session;
}

const set = (session: Session, location: string, key: string, value: string) => session.stage(location, { op: "set", path: key, value });

function heard(session: Session): Change[] {
  const seen: Change[] = [];
  session.onChange(c => void seen.push(c));
  return seen;
}

test("case 1: both clean: both written, the report says committed, the index is empty", async () => {
  const memory = createMemoryHost({ "/a.conf": A, "/b.conf": B });
  const { host, writes } = wrapped(memory);
  const session = await twoOn(host, memory, ["/a.conf", "/b.conf"]);
  const a = byLocation(session, "/a.conf").id;
  const b = byLocation(session, "/b.conf").id;
  await set(session, "/a.conf", "a", "9");
  await set(session, "/b.conf", "d", "8");
  assert.deepEqual(await session.commit(), {
    outcome: "committed",
    sources: [
      { source: a, location: "/a.conf", outcome: "written", version: sha(A9), edits: [{ path: "a", outcome: "written" }] },
      { source: b, location: "/b.conf", outcome: "written", version: sha(B8), edits: [{ path: "d", outcome: "written" }] },
    ],
  });
  assert.deepEqual(writes, [["/a.conf", A9], ["/b.conf", B8]]);
  assert.equal(await read(memory, "/a.conf"), A9);
  assert.equal(await read(memory, "/b.conf"), B8);
  assert.deepEqual(session.index(), []);
  session.close();
});

test("FR-007: an empty index is a committed commit with no sources", async () => {
  const memory = createMemoryHost({ "/a.conf": A });
  const session = await twoOn(memory, memory, ["/a.conf"]);
  assert.deepEqual(await session.commit(), { outcome: "committed", sources: [] });
  session.close();
});

test("case 2: an edit of b dropped on rebase aborts the commit: nothing written, a stays staged, a's disk is untouched", async () => {
  const memory = createMemoryHost({ "/a.conf": A, "/b.conf": B });
  const { host, writes } = wrapped(memory, { quiet: true });
  const session = await twoOn(host, memory, ["/a.conf", "/b.conf"]);
  const a = byLocation(session, "/a.conf").id;
  const b = byLocation(session, "/b.conf").id;
  await set(session, "/a.conf", "a", "9");
  await set(session, "/b.conf", "d", "8");
  await memory.write("/b.conf", "c=1\n"); // a colleague removed d
  assert.deepEqual(await session.commit(), {
    outcome: "aborted",
    sources: [
      { source: a, location: "/a.conf", outcome: "aborted", reason: "the commit was aborted by /b.conf", edits: [] },
      { source: b, location: "/b.conf", outcome: "conflicted", edits: [{ path: "d", outcome: "conflicted", reason: "gone", detail: "no key d" }] },
    ],
  });
  assert.deepEqual(writes, []);
  assert.equal(await read(memory, "/a.conf"), A);
  assert.deepEqual(session.index().map(e => [e.source, e.path, e.start, e.end]), [[a, "a", 2, 3]]);
  session.close();
});

test("FR-001, FR-002, FR-011: an aborted commit keeps its rebase notices, and a's edit stays staged on the version prepare rebased it onto", async () => {
  const memory = createMemoryHost({ "/a.conf": A, "/b.conf": B });
  const { host, writes } = wrapped(memory, { quiet: true });
  const session = await twoOn(host, memory, ["/a.conf", "/b.conf"]);
  const a = byLocation(session, "/a.conf").id;
  const b = byLocation(session, "/b.conf").id;
  await set(session, "/a.conf", "a", "9");
  await set(session, "/b.conf", "d", "8");
  await memory.write("/a.conf", "# n\n" + A); // a colleague prepends 4 bytes: a's value moves to 6-7
  await memory.write("/b.conf", "c=1\n");
  const changes = heard(session);
  const report = await session.commit();
  assert.equal(report.outcome, "aborted");
  assert.deepEqual(changes.flatMap(c => c.edits ?? []), [
    { source: a, path: "a", outcome: "moved", start: 6, end: 7 },
    { source: b, path: "d", outcome: "conflicted", reason: "gone", detail: "no key d" },
  ]);
  const [edit] = session.index();
  assert.deepEqual([edit?.path, edit?.base, edit?.start, edit?.end], ["a", sha("# n\n" + A), 6, 7]);
  // the retry, once b has nothing staged, lands a on the version it was rebased onto
  await session.unstage("/b.conf");
  assert.deepEqual((await session.commit()).outcome, "committed");
  assert.equal(await read(memory, "/a.conf"), "# n\na=9\nb=2\n");
  assert.deepEqual(writes, [["/a.conf", "# n\na=9\nb=2\n"]]);
  session.close();
});

test("case 3: b outside every writable root: nothing written, a aborted, b refused", async () => {
  const memory = createMemoryHost({ "/w/a.conf": A, "/x/b.conf": B });
  const { host, writes } = wrapped(memory);
  const session = await twoOn(host, memory, ["/w/a.conf", "/x/b.conf"], [keyValue], ["/w"]);
  const a = byLocation(session, "/w/a.conf").id;
  const b = byLocation(session, "/x/b.conf").id;
  await set(session, "/w/a.conf", "a", "9");
  await set(session, "/x/b.conf", "d", "8");
  assert.deepEqual(await session.commit(), {
    outcome: "aborted",
    sources: [
      { source: a, location: "/w/a.conf", outcome: "aborted", reason: "the commit was aborted by /x/b.conf", edits: [] },
      { source: b, location: "/x/b.conf", outcome: "refused", reason: "/x/b.conf is outside every writable root", edits: [] },
    ],
  });
  assert.deepEqual(writes, []);
  assert.equal(await read(memory, "/w/a.conf"), A);
  assert.deepEqual(session.index().map(e => e.path), ["a", "d"]);
  session.close();
});

test("case 4: b's disk version does not open (waiting): nothing written, a aborted, b refused", async () => {
  const picky: Writer = {
    claims: keyValue.claims,
    open: data => (new TextDecoder().decode(data).startsWith("!") ? { ok: false, reason: "not a conf file" } : keyValue.open(data)),
  };
  const memory = createMemoryHost({ "/a.conf": A, "/b.conf": B });
  const { host, writes } = wrapped(memory, { quiet: true });
  const session = await twoOn(host, memory, ["/a.conf", "/b.conf"], [picky]);
  const a = byLocation(session, "/a.conf").id;
  const b = byLocation(session, "/b.conf").id;
  await set(session, "/a.conf", "a", "9");
  await set(session, "/b.conf", "d", "8");
  await memory.write("/b.conf", "!\n" + B);
  assert.deepEqual(await session.commit(), {
    outcome: "aborted",
    sources: [
      { source: a, location: "/a.conf", outcome: "aborted", reason: "the commit was aborted by /b.conf", edits: [] },
      { source: b, location: "/b.conf", outcome: "refused", reason: "the file on disk does not open: not a conf file", edits: [] },
    ],
  });
  assert.deepEqual(writes, []);
  assert.equal(await read(memory, "/a.conf"), A);
  assert.deepEqual(session.index().map(e => [e.path, e.waiting]), [["a", undefined], ["d", "not a conf file"]]);
  session.close();
});

test("case 5: b's edit overrides a colleague's newer value: both written, b's edit overrode, the report says committed", async () => {
  const memory = createMemoryHost({ "/a.conf": A, "/b.conf": B });
  const { host } = wrapped(memory, { quiet: true });
  const session = await twoOn(host, memory, ["/a.conf", "/b.conf"]);
  await set(session, "/a.conf", "a", "9");
  await set(session, "/b.conf", "d", "8");
  await memory.write("/b.conf", "c=1\nd=5\n");
  const report = await session.commit();
  assert.equal(report.outcome, "committed");
  assert.deepEqual(report.sources.map(s => [s.outcome, s.edits.map(e => [e.path, e.outcome])]), [["written", [["a", "written"]]], ["written", [["d", "overrode"]]]]);
  assert.deepEqual(report.sources[1]?.edits[0]?.disk, bytes("5"));
  assert.equal(await read(memory, "/a.conf"), A9);
  assert.equal(await read(memory, "/b.conf"), B8);
  assert.deepEqual(session.index(), []);
  session.close();
});

test("case 6: the host fails b's write: a is put back byte for byte, a aborted, b failed, both edits stay staged, and a retry lands both", async () => {
  const memory = createMemoryHost({ "/a.conf": A, "/b.conf": B });
  let broken = true;
  const { host, writes } = wrapped(memory, { onWrite: location => (broken && location === "/b.conf" ? { ok: false, reason: "disk full" } : undefined) });
  const session = await twoOn(host, memory, ["/a.conf", "/b.conf"]);
  const a = byLocation(session, "/a.conf").id;
  const b = byLocation(session, "/b.conf").id;
  await set(session, "/a.conf", "a", "9");
  await set(session, "/b.conf", "d", "8");
  assert.deepEqual(await session.commit(), {
    outcome: "aborted",
    sources: [
      { source: a, location: "/a.conf", outcome: "aborted", reason: "the commit was aborted by /b.conf", edits: [] },
      { source: b, location: "/b.conf", outcome: "failed", reason: "disk full", edits: [] },
    ],
  });
  assert.deepEqual(writes, [["/a.conf", A9], ["/b.conf", B8], ["/a.conf", A]]);
  assert.equal(await read(memory, "/a.conf"), A);
  assert.equal(await read(memory, "/b.conf"), B);
  assert.deepEqual(session.index().map(e => [e.path, e.base]), [["a", sha(A)], ["d", sha(B)]]);
  broken = false;
  await new Promise(resolve => setTimeout(resolve, 5)); // the watcher hears the put-back and finds nothing new
  assert.equal((await session.commit()).outcome, "committed");
  assert.equal(await read(memory, "/a.conf"), A9);
  assert.equal(await read(memory, "/b.conf"), B8);
  session.close();
});

test("case 7: a colleague saves a between its write and the put-back: a is left as saved, unrestored, and its edit leaves the index", async () => {
  const memory = createMemoryHost({ "/a.conf": A, "/b.conf": B });
  const { host, writes } = wrapped(memory, {
    onWrite: async location => {
      if (location !== "/b.conf") return undefined;
      await memory.write("/a.conf", "a=5\nb=2\n"); // the colleague, while b's write is in flight
      return { ok: false, reason: "disk full" };
    },
  });
  const session = await twoOn(host, memory, ["/a.conf", "/b.conf"]);
  const a = byLocation(session, "/a.conf").id;
  const b = byLocation(session, "/b.conf").id;
  await set(session, "/a.conf", "a", "9");
  await set(session, "/b.conf", "d", "8");
  assert.deepEqual(await session.commit(), {
    outcome: "aborted",
    sources: [
      { source: a, location: "/a.conf", outcome: "unrestored", reason: "/a.conf was saved by someone else after this commit wrote it; left as it is", version: sha(A9), edits: [{ path: "a", outcome: "written" }] },
      { source: b, location: "/b.conf", outcome: "failed", reason: "disk full", edits: [] },
    ],
  });
  assert.deepEqual(writes, [["/a.conf", A9], ["/b.conf", B8]]); // no put-back write
  assert.equal(await read(memory, "/a.conf"), "a=5\nb=2\n");
  assert.deepEqual(session.index().map(e => e.path), ["d"]);
  session.close();
});

test("case 8: the put-back write of a fails too: a is unrestored, holding what this commit wrote", async () => {
  const memory = createMemoryHost({ "/a.conf": A, "/b.conf": B });
  const { host, writes } = wrapped(memory, {
    onWrite: (location, body) => (location === "/b.conf" ? { ok: false, reason: "disk full" } : location === "/a.conf" && body === A ? { ok: false, reason: "read-only" } : undefined),
  });
  const session = await twoOn(host, memory, ["/a.conf", "/b.conf"]);
  const a = byLocation(session, "/a.conf").id;
  await set(session, "/a.conf", "a", "9");
  await set(session, "/b.conf", "d", "8");
  const report = await session.commit();
  assert.deepEqual(report.sources[0], { source: a, location: "/a.conf", outcome: "unrestored", reason: "putting /a.conf back failed: read-only", version: sha(A9), edits: [{ path: "a", outcome: "written" }] });
  assert.equal(report.sources[1]?.outcome, "failed");
  assert.equal(report.outcome, "aborted");
  assert.deepEqual(writes, [["/a.conf", A9], ["/b.conf", B8], ["/a.conf", A]]);
  assert.equal(await read(memory, "/a.conf"), A9);
  assert.deepEqual(session.index().map(e => e.path), ["d"]);
  session.close();
});

test("case 8, read: a that cannot be read for the put-back is unrestored too, and is not written", async () => {
  const memory = createMemoryHost({ "/a.conf": A, "/b.conf": B });
  let unreadable = false;
  const { host, writes } = wrapped(memory, {
    onWrite: location => {
      if (location !== "/b.conf") return undefined;
      unreadable = true;
      return { ok: false, reason: "disk full" };
    },
    onRead: location => (unreadable && location === "/a.conf" ? "gone away" : undefined),
  });
  const session = await twoOn(host, memory, ["/a.conf", "/b.conf"]);
  await set(session, "/a.conf", "a", "9");
  await set(session, "/b.conf", "d", "8");
  const report = await session.commit();
  assert.deepEqual([report.sources[0]?.outcome, report.sources[0]?.reason], ["unrestored", "putting /a.conf back failed: could not read it: gone away"]);
  assert.deepEqual(writes, [["/a.conf", A9], ["/b.conf", B8]]);
  session.close();
});

test("case 9: two edits in one source, one dropped: nothing written, the source conflicted, the surviving edit stays staged", async () => {
  const memory = createMemoryHost({ "/a.conf": A });
  const { host, writes } = wrapped(memory, { quiet: true });
  const session = await twoOn(host, memory, ["/a.conf"]);
  const a = byLocation(session, "/a.conf").id;
  await set(session, "/a.conf", "a", "9");
  await set(session, "/a.conf", "b", "3");
  await memory.write("/a.conf", "a=1\n"); // b is gone; a's value is still at 2-3
  assert.deepEqual(await session.commit(), {
    outcome: "aborted",
    sources: [{ source: a, location: "/a.conf", outcome: "conflicted", edits: [{ path: "b", outcome: "conflicted", reason: "gone", detail: "no key b" }] }],
  });
  assert.deepEqual(writes, []);
  assert.equal(await read(memory, "/a.conf"), "a=1\n");
  assert.deepEqual(session.index().map(e => [e.path, e.start, e.end, e.base]), [["a", 2, 3, sha("a=1\n")]]);
  session.close();
});

test("case 10: three sources, the third fails to write: the first two are put back, newest first", async () => {
  const memory = createMemoryHost({ "/a.conf": A, "/b.conf": B, "/c.conf": C });
  const { host, writes } = wrapped(memory, { onWrite: location => (location === "/c.conf" ? { ok: false, reason: "disk full" } : undefined) });
  const session = await twoOn(host, memory, ["/a.conf", "/b.conf", "/c.conf"]);
  await set(session, "/a.conf", "a", "9");
  await set(session, "/b.conf", "d", "8");
  await set(session, "/c.conf", "e", "2");
  const report = await session.commit();
  assert.deepEqual(report.sources.map(s => [s.location, s.outcome]), [["/a.conf", "aborted"], ["/b.conf", "aborted"], ["/c.conf", "failed"]]);
  assert.deepEqual(writes, [["/a.conf", A9], ["/b.conf", B8], ["/c.conf", C2], ["/b.conf", B], ["/a.conf", A]]);
  assert.equal(await read(memory, "/a.conf"), A);
  assert.equal(await read(memory, "/b.conf"), B);
  assert.deepEqual(session.index().map(e => e.path), ["a", "d", "e"]);
  session.close();
});

test("a source that failed to read in prepare is the cause too: nothing is written", async () => {
  const memory = createMemoryHost({ "/a.conf": A, "/b.conf": B });
  let unreadable = false;
  const { host, writes } = wrapped(memory, { quiet: true, onRead: location => (unreadable && location === "/b.conf" ? "permission denied" : undefined) });
  const session = await twoOn(host, memory, ["/a.conf", "/b.conf"]);
  await set(session, "/a.conf", "a", "9");
  await set(session, "/b.conf", "d", "8");
  unreadable = true;
  const report = await session.commit();
  assert.deepEqual(report.sources.map(s => [s.outcome, s.reason]), [["aborted", "the commit was aborted by /b.conf"], ["failed", "permission denied"]]);
  assert.deepEqual(writes, []);
  session.close();
});

test("when two sources are causes, each keeps its own outcome and the first names itself as the cause of the rest", async () => {
  const memory = createMemoryHost({ "/w/a.conf": A, "/x/b.conf": B, "/y/c.conf": C });
  const { host } = wrapped(memory);
  const session = await twoOn(host, memory, ["/w/a.conf", "/x/b.conf", "/y/c.conf"], [keyValue], ["/w"]);
  await set(session, "/w/a.conf", "a", "9");
  await set(session, "/x/b.conf", "d", "8");
  await set(session, "/y/c.conf", "e", "2");
  const report = await session.commit();
  assert.deepEqual(report.sources.map(s => [s.outcome, s.reason]), [["aborted", "the commit was aborted by /x/b.conf"], ["refused", "/x/b.conf is outside every writable root"], ["refused", "/y/c.conf is outside every writable root"]]);
  session.close();
});

// FR-012: a throw keeps today's behaviour --------------------------------------------------------

test("FR-012: a writer that throws in prepare rejects the commit with nothing written, even for sources before it", async () => {
  let broken = false;
  const throwing: Writer = {
    claims: keyValue.claims,
    open: data => {
      const opened = keyValue.open(data);
      if (!opened.ok) return opened;
      return { ok: true, document: { ...opened.document, locate: path => (broken && new TextDecoder().decode(data).includes("c=1") ? (() => { throw new Error("writer broke"); })() : opened.document.locate(path)) } };
    },
  };
  const memory = createMemoryHost({ "/a.conf": A, "/b.conf": B });
  const { host, writes } = wrapped(memory, { quiet: true });
  const session = await twoOn(host, memory, ["/a.conf", "/b.conf"], [throwing]);
  await set(session, "/a.conf", "a", "9");
  await set(session, "/b.conf", "d", "8");
  const before = session.index();
  broken = true;
  await memory.write("/b.conf", "# n\n" + B);
  await memory.write("/a.conf", "# n\n" + A);
  await assert.rejects(session.commit(), /writer broke/);
  assert.deepEqual(writes, []);
  assert.deepEqual(session.index(), before);
  session.close();
});

test("FR-012: a host write that throws mid-commit rejects the call; the source already written leaves the index and stays on disk (no undo on a throw)", async () => {
  const memory = createMemoryHost({ "/a.conf": A, "/b.conf": B });
  const { host, writes } = wrapped(memory, {
    quiet: true,
    onWrite: location => {
      if (location === "/b.conf") throw new Error("host broke");
      return undefined;
    },
  });
  const session = await twoOn(host, memory, ["/a.conf", "/b.conf"]);
  await set(session, "/a.conf", "a", "9");
  await set(session, "/b.conf", "d", "8");
  await assert.rejects(session.commit(), /host broke/);
  assert.deepEqual(writes, [["/a.conf", A9], ["/b.conf", B8]]);
  assert.equal(await read(memory, "/a.conf"), A9);
  assert.deepEqual(session.index().map(e => e.path), ["d"]);
  session.close();
});

// Case 11: the Node host -------------------------------------------------------------------------

test("case 11: on a real disk, b's directory refuses a new file: a's bytes and mode are as before the commit", async t => {
  if (process.getuid?.() === 0) return t.skip("root writes anywhere");
  const dir = await scratch(t, "provenance-atomic-");
  const sub = path.join(dir, "sub");
  await fs.mkdir(sub);
  const fileA = path.join(dir, "a.conf");
  const fileB = path.join(sub, "b.conf");
  await fs.writeFile(fileA, A, { mode: 0o640 });
  await fs.writeFile(fileB, B);
  const modeBefore = (await fs.stat(fileA)).mode;
  const session = closing(t, await openSession({ host: createNodeHost({ debounce: 20 }), entry: fileA, handlers: [], writers: [keyValue], writable: [dir] }));
  try {
    await session.addRoot(fileB);
    await set(session, fileA, "a", "9");
    await set(session, fileB, "d", "8");
    await fs.chmod(sub, 0o555); // the temporary file cannot be created beside b.conf; a read-only b.conf would not stop a rename
    const report = await session.commit();
    assert.deepEqual(report.sources.map(s => s.outcome), ["aborted", "failed"]);
    assert.equal(report.outcome, "aborted");
    assert.equal(await fs.readFile(fileA, "utf8"), A);
    assert.equal((await fs.stat(fileA)).mode, modeBefore);
    assert.equal(await fs.readFile(fileB, "utf8"), B);
    assert.deepEqual(await fs.readdir(dir), ["a.conf", "sub"]); // no temporary file left behind
    assert.deepEqual(session.index().map(e => e.path), ["a", "d"]);
  } finally {
    await fs.chmod(sub, 0o755);
    session.close();
  }
});
