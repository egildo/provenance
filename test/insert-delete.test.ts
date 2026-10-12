import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonWriter, yamlWriter } from "@egildo/cascata/writers";
import { openSession } from "../src/index.ts";
import type { Change, EditData, Host, Session, Writer } from "../src/index.ts";
import { createMemoryHost } from "../src/memory.ts";
import { absorbed, byLocation, keyValue, keyValueShot, opened } from "./helpers.ts";

// The insert-and-delete round (specs/insert-delete/spec.md). Every expected value is counted by hand.
// The key=value file /w.conf is `a=1⏎b=2⏎`, 8 bytes: a's value at 2-3, b's at 6-7.

const W = "a=1\nb=2\n";
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);
const quiet = (memory: ReturnType<typeof createMemoryHost>): Host => ({ ...memory, watch: () => ({ set: () => undefined, close: () => undefined }) });

async function openOn(files: Record<string, string>, writers: readonly Writer[], extra: { quiet?: boolean } = {}) {
  const memory = createMemoryHost(files);
  const host = extra.quiet ? quiet(memory) : memory;
  const session = await openSession({ host, entry: Object.keys(files)[0] ?? "/w.conf", handlers: [], writers, writable: ["/"] });
  return { memory, session };
}

const idOf = (session: Session, location: string) => byLocation(session, location).id;
const previewText = async (session: Session, location: string) => text((await session.preview(idOf(session, location)))?.bytes ?? new Uint8Array());

function heard(session: Session): Change[] {
  const changes: Change[] = [];
  session.onChange(change => changes.push(change));
  return changes;
}

/** Counts `open` calls: the witness for "one opening per version" (insert-delete FR-002), never a timer. */
function counting(writer: Writer) {
  const calls = { opens: 0 };
  const counted: Writer = {
    ...writer,
    open(data) {
      calls.opens++;
      return writer.open(data);
    },
  };
  return { calls, counted };
}

// ---- Part A: the opened writer (FR-001 to FR-003) ----

test("FR-002: staging many edits on one source opens its base once", async () => {
  const { calls, counted } = counting(keyValue);
  const { session } = await openOn({ "/w.conf": W }, [counted]);
  assert.equal(calls.opens, 0); // reading a source never opens it
  await session.stage("/w.conf", { op: "set", path: "a", value: "7" });
  await session.stage("/w.conf", { op: "set", path: "b", value: "8" });
  await session.stage("/w.conf", { op: "set", path: "b", value: "9" }); // a restage
  assert.equal(calls.opens, 1);
  assert.equal(await previewText(session, "/w.conf"), "a=7\nb=9\n");
  session.close();
});

test("FR-002: a rebase of several edits opens the new version once", async () => {
  const { calls, counted } = counting(keyValue);
  const { session, memory } = await openOn({ "/w.conf": W }, [counted]);
  await session.stage("/w.conf", { op: "set", path: "a", value: "7" });
  await session.stage("/w.conf", { op: "set", path: "b", value: "8" });
  assert.equal(calls.opens, 1);
  memory.write("/w.conf", "# note\na=1\nb=2\n"); // "# note⏎" is 7 bytes: a's value moves to 9-10, b's to 13-14
  await absorbed(session, "/w.conf");
  assert.deepEqual(session.index().map(e => [e.path, e.start, e.end]), [["a", 9, 10], ["b", 13, 14]]);
  assert.equal(calls.opens, 2);
  session.close();
});

test("FR-002: a commit that meets a moved disk opens that version once, and one that meets none opens nothing further", async () => {
  const { calls, counted } = counting(keyValue);
  const { session, memory } = await openOn({ "/w.conf": W }, [counted], { quiet: true });
  await session.stage("/w.conf", { op: "set", path: "a", value: "7" });
  await session.stage("/w.conf", { op: "set", path: "b", value: "8" });
  memory.write("/w.conf", "# note\na=1\nb=2\n");
  await session.commit();
  assert.equal(calls.opens, 2); // the base at staging, the moved disk at commit
  const { calls: again, counted: other } = counting(keyValue);
  const second = await openOn({ "/w.conf": W }, [other], { quiet: true });
  await second.session.stage("/w.conf", { op: "set", path: "a", value: "7" });
  await second.session.commit();
  assert.equal(again.opens, 1);
  second.session.close();
  session.close();
});

test("FR-002: bytes that do not open are refused at staging with the writer's reason", async () => {
  const unopenable = (data: Uint8Array) => data[0] === 0x21;
  const picky: Writer = {
    claims: keyValue.claims,
    open: data => (unopenable(data) ? { ok: false, reason: "not a conf file" } : keyValue.open(data)),
  };
  const { session } = await openOn({ "/w.conf": "!\na=1\n" }, [picky]);
  assert.deepEqual(await session.stage("/w.conf", { op: "set", path: "a", value: "2" }), { ok: false, reason: "not a conf file" });
  assert.deepEqual(session.index(), []);
  session.close();
});

test("FR-002: bytes that do not open make every edit unwritable on rebase", async () => {
  const picky: Writer = {
    claims: keyValue.claims,
    open: data => (data[0] === 0x21 ? { ok: false, reason: "not a conf file" } : keyValue.open(data)),
  };
  const { session, memory } = await openOn({ "/w.conf": W }, [picky]);
  const id = idOf(session, "/w.conf");
  await session.stage("/w.conf", { op: "set", path: "a", value: "7" });
  await session.stage("/w.conf", { op: "set", path: "b", value: "8" });
  const changes = heard(session);
  memory.write("/w.conf", "!\na=1\nb=2\n");
  await absorbed(session, "/w.conf");
  assert.deepEqual(session.index(), []);
  assert.deepEqual(changes.flatMap(c => c.edits ?? []), [
    { source: id, path: "a", outcome: "conflicted", reason: "unwritable" },
    { source: id, path: "b", outcome: "conflicted", reason: "unwritable" },
  ]);
  session.close();
});

test("FR-003: a one-shot writer, adapted by `opened`, behaves as before (set, commit, rebase)", async () => {
  const { session, memory } = await openOn({ "/w.conf": W }, [opened(keyValueShot)]);
  await session.stage("/w.conf", { op: "set", path: "b", value: "3" });
  memory.write("/w.conf", "# note\na=1\nb=2\n");
  await absorbed(session, "/w.conf");
  await session.commit();
  const disk = await memory.read("/w.conf");
  assert.equal(disk.ok && text(disk.bytes), "# note\na=1\nb=3\n");
  assert.equal(bytes(W).length, 8);
  session.close();
});

// ---- Part B: containers (FR-004, FR-005) ----
// write-back.md's walls.yaml, 51 bytes: `walls:⏎` 0-6, `  W1:⏎` 7-12, `    height: 3.2⏎` 13-28 (3.2 at 25-28),
// `  W2:⏎` 29-34, `    height: 3.2⏎` 35-50 (the mapping under W2 is bytes 39-50, 3.2 at 47-50).

const WALLS = "walls:\n  W1:\n    height: 3.2\n  W2:\n    height: 3.2\n";
const read = async (memory: Host, location: string) => {
  const result = await memory.read(location);
  return result.ok ? text(result.bytes) : result.reason;
};

test("FR-004: a set may carry a mapping; only the value's bytes move, the mapping is written block-style under W2", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  const wall = new Map<string, EditData>([["height", 3.4], ["thickness", 0.2]]);
  assert.deepEqual(await session.stage("/g/walls.yaml", { op: "set", path: "/walls/W2", value: wall }), { ok: true });
  // The mapping under W2 is 39-50 (`height: 3.2`); it is replaced by two entries, the second at the first's indentation.
  assert.deepEqual(session.index().map(e => [e.path, e.start, e.end]), [["/walls/W2", 39, 50]]);
  const after = "walls:\n  W1:\n    height: 3.2\n  W2:\n    height: 3.4\n    thickness: 0.2\n";
  assert.equal(await previewText(session, "/g/walls.yaml"), after);
  await session.commit();
  assert.equal(await read(memory, "/g/walls.yaml"), after);
  assert.equal(after.slice(0, 39), WALLS.slice(0, 39)); // L3: nothing before the value moved
  assert.equal(after.slice(-1), WALLS.slice(-1)); // nor the final newline
  session.close();
});

test("FR-004: a set may carry a sequence (JSON), the bigints written as integers", async () => {
  const { session, memory } = await openOn({ "/d.json": '{"a": 1}' }, [jsonWriter()]);
  assert.deepEqual(await session.stage("/d.json", { op: "set", path: "/a", value: [1n, 2n] }), { ok: true });
  assert.deepEqual(session.index().map(e => [e.start, e.end]), [[6, 7]]); // `{"a": 1}`: the 1 is byte 6
  assert.equal(await previewText(session, "/d.json"), '{"a": [1, 2]}');
  await session.commit();
  assert.equal(await read(memory, "/d.json"), '{"a": [1, 2]}');
  session.close();
});

test("FR-005: index() carries the op, and the value as staged: a Map stays the same Map", async () => {
  const { session } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  const wall = new Map<string, EditData>([["height", 3.4]]);
  await session.stage("/g/walls.yaml", { op: "set", path: "/walls/W2", value: wall });
  await session.stage("/g/walls.yaml", { op: "set", path: "/walls/W1/height", value: 3.4 });
  const [container, scalar] = session.index();
  assert.equal(container?.op, "set");
  assert.ok(container?.value instanceof Map);
  assert.equal(container?.value, wall);
  assert.equal(scalar?.op, "set");
  assert.equal(scalar?.value, 3.4);
  session.close();
});

test("FR-004: a plain object is not EditData: a compile error, and Cascata's writer throws, so the call rejects and nothing is staged", async () => {
  const { session } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  // @ts-expect-error a plain object is not EditData
  await assert.rejects(session.stage("/g/walls.yaml", { op: "set", path: "/walls/W2", value: { height: 3.4 } }), TypeError);
  assert.deepEqual(session.index(), []);
  assert.deepEqual(await session.stage("/g/walls.yaml", { op: "set", path: "/walls/W2/height", value: 3.4 }), { ok: true }); // the session carries on
  session.close();
});

test("FR-004: a staged container is rebased like any value: a comment added above moves it", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  await session.stage("/g/walls.yaml", { op: "set", path: "/walls/W2", value: new Map<string, EditData>([["height", 3.4], ["thickness", 0.2]]) });
  memory.write("/g/walls.yaml", "# c\n" + WALLS); // 4 bytes: 39-50 becomes 43-54
  await absorbed(session, "/g/walls.yaml");
  assert.deepEqual(session.index().map(e => [e.start, e.end, e.status]), [[43, 54, "staged"]]);
  await session.commit();
  assert.equal(await read(memory, "/g/walls.yaml"), "# c\n" + "walls:\n  W1:\n    height: 3.2\n  W2:\n    height: 3.4\n    thickness: 0.2\n");
  session.close();
});
