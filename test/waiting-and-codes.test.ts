import { test } from "node:test";
import assert from "node:assert/strict";
import { yamlWriter } from "@egildo/cascata/writers";
import { openSession } from "../src/index.ts";
import type { Change, Host, Writer, WriterDocument } from "../src/index.ts";
import { createMemoryHost } from "../src/memory.ts";
import { absorbed, byLocation, keyValue } from "./helpers.ts";

// The fixes after the insert-delete round's report (specs/insert-delete/fixes.md). Every value is counted by hand.

const text = (data: Uint8Array) => new TextDecoder().decode(data);
const quiet = (memory: ReturnType<typeof createMemoryHost>): Host => ({ ...memory, watch: () => ({ set: () => undefined, close: () => undefined }) });
const read = async (memory: Host, location: string) => {
  const result = await memory.read(location);
  return result.ok ? text(result.bytes) : undefined;
};
async function openOn(files: Record<string, string>, writers: readonly Writer[], extra: { quiet?: boolean } = {}) {
  const memory = createMemoryHost(files);
  const session = await openSession({ host: extra.quiet ? quiet(memory) : memory, entry: Object.keys(files)[0] ?? "/w.conf", handlers: [], writers, writable: ["/"] });
  return { memory, session };
}
function heard(session: { onChange(l: (c: Change) => void): () => void }): Change[] {
  const changes: Change[] = [];
  session.onChange(change => changes.push(change));
  return changes;
}

// --- FIX-001: a version that does not open holds the staged edits; it does not drop them ---------------------

const picky: Writer = {
  claims: keyValue.claims,
  open: data => (data[0] === 0x21 ? { ok: false, reason: "not a conf file" } : keyValue.open(data)),
};

test("FIX-001: a version that does not open leaves every staged edit waiting, with the writer's words", async () => {
  // `a=1⏎b=2⏎`: a's value at 2-3, b's at 6-7.
  const { session, memory } = await openOn({ "/w.conf": "a=1\nb=2\n" }, [picky]);
  const id = byLocation(session, "/w.conf").id;
  await session.stage("/w.conf", { op: "set", path: "a", value: "7" });
  await session.stage("/w.conf", { op: "set", path: "b", value: "8" });
  const changes = heard(session);
  memory.write("/w.conf", "!\na=1\nb=2\n");
  await absorbed(session, "/w.conf");
  assert.deepEqual(changes.flatMap(c => c.edits ?? []), [
    { source: id, path: "a", outcome: "waiting", detail: "not a conf file" },
    { source: id, path: "b", outcome: "waiting", detail: "not a conf file" },
  ]);
  assert.deepEqual(session.index().map(e => [e.path, e.start, e.end, e.status, e.waiting]), [
    ["a", 2, 3, "staged", "not a conf file"],
    ["b", 6, 7, "staged", "not a conf file"],
  ]);
  assert.equal(text((await session.preview(id))?.bytes ?? new Uint8Array()), "a=7\nb=8\n");
  session.close();
});

test("FIX-001: a commit while the disk does not open is refused for that source, writes nothing, and keeps the edits", async () => {
  const { session, memory } = await openOn({ "/w.conf": "a=1\nb=2\n" }, [picky], { quiet: true });
  const id = byLocation(session, "/w.conf").id;
  await session.stage("/w.conf", { op: "set", path: "a", value: "7" });
  memory.write("/w.conf", "!\na=1\nb=2\n");
  assert.deepEqual(await session.commit(), {
    sources: [{ source: id, location: "/w.conf", outcome: "refused", reason: "the file on disk does not open: not a conf file", edits: [] }],
  });
  assert.equal(await read(memory, "/w.conf"), "!\na=1\nb=2\n");
  assert.deepEqual(session.index().map(e => [e.path, e.waiting]), [["a", "not a conf file"]]);
  session.close();
});

test("FIX-001: when the file opens again the waiting edits rebase from their base as usual, and commit", async () => {
  const { session, memory } = await openOn({ "/w.conf": "a=1\nb=2\n" }, [picky]);
  const id = byLocation(session, "/w.conf").id;
  await session.stage("/w.conf", { op: "set", path: "a", value: "7" });
  await session.stage("/w.conf", { op: "set", path: "b", value: "8" });
  memory.write("/w.conf", "!\na=1\nb=2\n");
  await absorbed(session, "/w.conf");
  const changes = heard(session);
  memory.write("/w.conf", "# n\na=1\nb=2\n"); // "# n⏎" is 4 bytes: a's value at 6-7, b's at 10-11
  await absorbed(session, "/w.conf");
  assert.deepEqual(changes.flatMap(c => c.edits ?? []), [
    { source: id, path: "a", outcome: "moved", start: 6, end: 7 },
    { source: id, path: "b", outcome: "moved", start: 10, end: 11 },
  ]);
  assert.deepEqual(session.index().map(e => [e.path, e.start, e.end, e.waiting]), [["a", 6, 7, undefined], ["b", 10, 11, undefined]]);
  await session.commit();
  assert.equal(await read(memory, "/w.conf"), "# n\na=7\nb=8\n");
  session.close();
});

// --- FIX-002: `changed` compares everything the delete would cut, the attached comments included -------------

const WALLS = "walls:\n  W1:\n    height: 3.2\n  W2:\n    height: 3.2\n";

test("FIX-002: a comment a colleague attached to the entry makes its delete conflicted `changed`, and the comment survives", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  const id = byLocation(session, "/g/walls.yaml").id;
  assert.deepEqual(await session.stage("/g/walls.yaml", { op: "remove", path: "/walls/W1" }), { ok: true });
  const changes = heard(session);
  const theirs = "walls:\n  # keep me\n  W1:\n    height: 3.2\n  W2:\n    height: 3.2\n";
  memory.write("/g/walls.yaml", theirs);
  await absorbed(session, "/g/walls.yaml");
  assert.deepEqual(changes.flatMap(c => c.edits ?? []), [{ source: id, path: "/walls/W1", outcome: "conflicted", reason: "changed" }]);
  assert.deepEqual(session.index(), []);
  assert.equal(await read(memory, "/g/walls.yaml"), theirs);
  session.close();
});

test("FIX-002: a comment elsewhere moves the delete and does not stop it", async () => {
  // The delete cuts W1's two lines, 7-29 in the base; "# top⏎" (6 bytes) above moves them to 13-35.
  const { session, memory } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  const id = byLocation(session, "/g/walls.yaml").id;
  await session.stage("/g/walls.yaml", { op: "remove", path: "/walls/W1" });
  assert.deepEqual(session.index().map(e => [e.start, e.end]), [[7, 29]]);
  const changes = heard(session);
  memory.write("/g/walls.yaml", "# top\n" + WALLS);
  await absorbed(session, "/g/walls.yaml");
  assert.deepEqual(changes.flatMap(c => c.edits ?? []), [{ source: id, path: "/walls/W1", outcome: "moved", start: 13, end: 35 }]);
  await session.commit();
  assert.equal(await read(memory, "/g/walls.yaml"), "# top\nwalls:\n  W2:\n    height: 3.2\n");
  session.close();
});

// --- FIX-003: a refusal's code says why, where the writer gives one ---------------------------------------

/** A writer whose `add` succeeds on a file starting `base` and otherwise refuses with the file's first word as its code. */
const coded: Writer = {
  claims: location => location.endsWith(".conf"),
  open(bytes) {
    const body = text(bytes);
    const code = body.split(/\s/)[0] ?? "";
    const document: WriterDocument = {
      locate: path => (body.includes(`${path}=`) ? { ok: true, start: 0, end: 0 } : { ok: false, reason: `no ${path}` }),
      write: () => ({ ok: false, reason: "not used" }),
      add: (path, value) =>
        body.startsWith("base")
          ? { ok: true, edit: { start: bytes.length, end: bytes.length, bytes: new TextEncoder().encode(`${path}=${String(value)}\n`) } }
          : code === "nocode"
            ? { ok: false, reason: "refused" }
            : { ok: false, reason: "refused", code },
    };
    return { ok: true, document };
  },
};

for (const [disk, reason, why] of [
  ["edit-target-exists\n", "exists", "the code says the key exists, though the key is not found"],
  ["edit-target-absent k=\n", "gone", "the code says the place is gone, though the key is found"],
  ["edit-parent-scalar\n", "gone", "a parent that became a scalar is gone"],
  ["edit-read-back\n", "unwritable", "any other code is unwritable"],
  ["nocode k=\n", "exists", "no code: the key is found, so exists"],
  ["nocode\n", "gone", "no code: the key is not found, so gone"],
] as const) {
  test(`FIX-003: a rebased insert refused with ${JSON.stringify(disk.trim())} is ${reason}: ${why}`, async () => {
    const { session, memory } = await openOn({ "/w.conf": "base\n" }, [coded]);
    const id = byLocation(session, "/w.conf").id;
    assert.deepEqual(await session.stage("/w.conf", { op: "add", path: "k", value: "1" }), { ok: true });
    const changes = heard(session);
    memory.write("/w.conf", disk);
    await absorbed(session, "/w.conf");
    assert.deepEqual(changes.flatMap(c => c.edits ?? []), [{ source: id, path: "k", outcome: "conflicted", reason }]);
    session.close();
  });
}
