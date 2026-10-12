import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonWriter, yamlWriter } from "@egildo/cascata/writers";
import { openSession } from "../src/index.ts";
import type { Change, EditData, Handler, Host, Session, Writer } from "../src/index.ts";
import { createMemoryHost } from "../src/memory.ts";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createNodeHost } from "../src/node.ts";
import { absorbed, byLocation, closing, keyValue, keyValueShot, opened, scratch, tick, unhandled } from "./helpers.ts";

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

// ---- Part C: insert (FR-006 to FR-008) ----
// The added entries below are 22 bytes each: `  W3:⏎` (6) and `    height: 3.2⏎` (16). The file's 51 bytes
// end with a newline, so an entry added after the last one is spliced in at 51, empty-ranged.

const W3 = "  W3:\n    height: 3.2\n";
const W4 = "  W4:\n    height: 3.4\n";
const wall = (height: number) => new Map<string, EditData>([["height", height]]);
const add = (session: Session, path: string, value: EditData, location = "/g/walls.yaml") => session.stage(location, { op: "add", path, value });

test("FR-006, write-back.md: walls.yaml gains W3 whole; the preview and the commit are the file plus 22 bytes at 51", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  assert.deepEqual(await add(session, "/walls/W3", wall(3.2)), { ok: true });
  const [edit] = session.index();
  assert.deepEqual([edit?.op, edit?.path, edit?.start, edit?.end, edit?.status], ["add", "/walls/W3", 51, 51, "staged"]);
  assert.ok(edit?.value instanceof Map);
  assert.equal(await previewText(session, "/g/walls.yaml"), WALLS + W3);
  assert.equal((await session.preview(idOf(session, "/g/walls.yaml")))?.bytes.length, 51 + 22);
  const report = await session.commit();
  assert.deepEqual(report.sources.map(s => [s.outcome, s.edits]), [["written", [{ path: "/walls/W3", outcome: "written" }]]]);
  assert.equal(await read(memory, "/g/walls.yaml"), WALLS + W3); // L3: the first 51 bytes are exactly the old file
  session.close();
});

test("FR-006: the writer's own refusals are the staging refusals, verbatim: an existing key, an absent parent, a scalar parent", async () => {
  const { session } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  const direct = yamlWriter().open(bytes(WALLS));
  assert.ok(direct.ok);
  for (const path of ["/walls/W2", "/nowhere/x", "/walls/W1/height/x"]) {
    const refusal = direct.document.add?.(path, 1);
    assert.equal(refusal?.ok, false);
    assert.deepEqual(await add(session, path, 1), { ok: false, reason: refusal?.ok === false ? refusal.reason : "" }, path);
  }
  assert.deepEqual(session.index(), []);
  session.close();
});

test("FR-006: a writer whose document has no add refuses an insert by name", async () => {
  const { session } = await openOn({ "/w.conf": W }, [keyValue]);
  assert.deepEqual(await add(session, "c", "3", "/w.conf"), { ok: false, reason: "the writer for /w.conf cannot add: its document has no add" });
  assert.deepEqual(session.index(), []);
  session.close();
});

test("FR-007: an insert carries over a comment added above it, and the notice says where it went", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  const id = idOf(session, "/g/walls.yaml");
  await add(session, "/walls/W3", wall(3.2));
  const changes = heard(session);
  memory.write("/g/walls.yaml", "# from survey\n" + WALLS); // 14 bytes: 51 becomes 65
  await absorbed(session, "/g/walls.yaml");
  assert.deepEqual(session.index().map(e => [e.op, e.start, e.end, e.status]), [["add", 65, 65, "staged"]]);
  assert.deepEqual(changes.flatMap(c => c.edits ?? []), [{ source: id, path: "/walls/W3", outcome: "moved", start: 65, end: 65 }]);
  await session.commit();
  assert.equal(await read(memory, "/g/walls.yaml"), "# from survey\n" + WALLS + W3);
  session.close();
});

test("FR-007: a key a colleague has added meanwhile makes the insert conflicted `exists`, and the colleague's entry is kept (different)", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  const id = idOf(session, "/g/walls.yaml");
  await add(session, "/walls/W3", wall(3.2));
  const changes = heard(session);
  const theirs = WALLS + "  W3:\n    height: 9.9\n";
  memory.write("/g/walls.yaml", theirs);
  await absorbed(session, "/g/walls.yaml");
  assert.deepEqual(session.index(), []);
  assert.deepEqual(changes.flatMap(c => c.edits ?? []), [{ source: id, path: "/walls/W3", outcome: "conflicted", reason: "exists" }]);
  assert.deepEqual(await session.commit(), { sources: [] });
  assert.equal(await read(memory, "/g/walls.yaml"), theirs);
  session.close();
});

test("FR-007: ... and even when the colleague's entry equals the staged one", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  await add(session, "/walls/W3", wall(3.2));
  const changes = heard(session);
  memory.write("/g/walls.yaml", WALLS + W3);
  await absorbed(session, "/g/walls.yaml");
  assert.deepEqual(changes.flatMap(c => c.edits ?? []).map(e => [e.outcome, e.reason]), [["conflicted", "exists"]]);
  assert.deepEqual(session.index(), []);
  assert.equal(await read(memory, "/g/walls.yaml"), WALLS + W3);
  session.close();
});

test("FR-007: a commit that meets the colleague's key first reports the source conflicted `exists` and writes nothing", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()], { quiet: true });
  const id = idOf(session, "/g/walls.yaml");
  await add(session, "/walls/W3", wall(3.2));
  memory.write("/g/walls.yaml", WALLS + "  W3:\n    height: 9.9\n");
  assert.deepEqual(await session.commit(), { sources: [{ source: id, location: "/g/walls.yaml", outcome: "conflicted", edits: [{ path: "/walls/W3", outcome: "conflicted", reason: "exists" }] }] });
  assert.equal(await read(memory, "/g/walls.yaml"), WALLS + "  W3:\n    height: 9.9\n");
  session.close();
});

test("FR-007: a parent a colleague has removed makes the insert conflicted `gone`", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  const id = idOf(session, "/g/walls.yaml");
  await add(session, "/walls/W3", wall(3.2));
  const changes = heard(session);
  memory.write("/g/walls.yaml", "doors:\n  D1: 1\n");
  await absorbed(session, "/g/walls.yaml");
  assert.deepEqual(session.index(), []);
  assert.deepEqual(changes.flatMap(c => c.edits ?? []), [{ source: id, path: "/walls/W3", outcome: "conflicted", reason: "gone" }]);
  session.close();
});

test("FR-007: a parent that has become a scalar is `gone` too: the session cannot tell it from an absent one without reading the path", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  await add(session, "/walls/W3", wall(3.2));
  const changes = heard(session);
  memory.write("/g/walls.yaml", "walls: 5\n");
  await absorbed(session, "/g/walls.yaml");
  assert.deepEqual(changes.flatMap(c => c.edits ?? []).map(e => [e.outcome, e.reason]), [["conflicted", "gone"]]);
  session.close();
});

test("FR-008: two appends to one container are spliced in staging order, in the preview and at commit; the reverse order gives the reverse text", async () => {
  for (const [first, second, expected] of [
    [["/walls/W3", 3.2], ["/walls/W4", 3.4], WALLS + W3 + W4],
    [["/walls/W4", 3.4], ["/walls/W3", 3.2], WALLS + W4 + W3],
  ] as const) {
    const { session, memory } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
    assert.deepEqual(await add(session, first[0], wall(first[1])), { ok: true });
    assert.deepEqual(await add(session, second[0], wall(second[1])), { ok: true });
    assert.deepEqual(session.index().map(e => [e.start, e.end]), [[51, 51], [51, 51]]);
    assert.equal(await previewText(session, "/g/walls.yaml"), expected);
    await session.commit();
    assert.equal(await read(memory, "/g/walls.yaml"), expected);
    session.close();
  }
});

test("FR-008: two appends at one spot survive a rebase in staging order", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  await add(session, "/walls/W4", wall(3.4));
  await add(session, "/walls/W3", wall(3.2));
  memory.write("/g/walls.yaml", "# c\n" + WALLS); // 4 bytes: both go to 55
  await absorbed(session, "/g/walls.yaml");
  assert.deepEqual(session.index().map(e => [e.path, e.start, e.end]), [["/walls/W4", 55, 55], ["/walls/W3", 55, 55]]);
  await session.commit();
  assert.equal(await read(memory, "/g/walls.yaml"), "# c\n" + WALLS + W4 + W3);
  session.close();
});

test("FR-008: two inserts into one empty container overlap (the writer rewrites the braces for each): the second is refused", async () => {
  const { session } = await openOn({ "/g/walls.yaml": "walls: {}\n" }, [yamlWriter()]);
  assert.deepEqual(await add(session, "/walls/W3", wall(3.2)), { ok: true });
  const second = await add(session, "/walls/W4", wall(3.4));
  assert.equal(second.ok, false);
  assert.match(second.ok ? "" : second.reason, /overlaps the staged edit at \/walls\/W3/);
  assert.deepEqual(session.index().map(e => e.path), ["/walls/W3"]);
  session.close();
});

test("FR-008: any other overlap is still refused: an empty insert strictly inside another edit's range; one at its edge is not", async () => {
  // A toy writer: a set answers 2-4, an add of "mid" answers the empty range 3, one of "edge" the empty range 4.
  const toy: Writer = {
    claims: keyValue.claims,
    open: () => ({
      ok: true,
      document: {
        locate: () => ({ ok: true, start: 2, end: 4 }),
        write: () => ({ ok: true, edit: { start: 2, end: 4, bytes: bytes("Z") } }),
        add: path => ({ ok: true, edit: { start: path === "mid" ? 3 : 4, end: path === "mid" ? 3 : 4, bytes: bytes("Y") } }),
      },
    }),
  };
  const { session } = await openOn({ "/w.conf": W }, [toy]);
  assert.deepEqual(await session.stage("/w.conf", { op: "set", path: "x", value: "1" }), { ok: true });
  const mid = await add(session, "mid", "1", "/w.conf");
  assert.equal(mid.ok, false);
  assert.match(mid.ok ? "" : mid.reason, /overlaps the staged edit at x/);
  assert.deepEqual(await add(session, "edge", "1", "/w.conf"), { ok: true });
  // `a=1⏎b=2⏎`: x replaces bytes 2-3 (`1⏎`) with Z; the insert at 4 goes between that and `b`.
  assert.equal(await previewText(session, "/w.conf"), "a=ZYb=2\n");
  session.close();
});

test("FR-007: a writer whose new version no longer offers add makes the insert unwritable", async () => {
  // Bytes beginning with `!` open as a document without `add`.
  const fickle: Writer = {
    claims: keyValue.claims,
    open: data => {
      const opened = keyValue.open(data);
      if (!opened.ok) return opened;
      const { locate, write } = opened.document;
      const add = (path: string) => ({ ok: true as const, edit: { start: data.length, end: data.length, bytes: bytes(`${path}=0\n`) } });
      return { ok: true, document: data[0] === 0x21 ? { locate, write } : { locate, write, add } };
    },
  };
  const { session, memory } = await openOn({ "/w.conf": W }, [fickle]);
  const id = idOf(session, "/w.conf");
  assert.deepEqual(await add(session, "c", "3", "/w.conf"), { ok: true });
  assert.equal(await previewText(session, "/w.conf"), "a=1\nb=2\nc=0\n"); // the toy `add` writes `c=0`: only its splice is the writer's
  const changes = heard(session);
  memory.write("/w.conf", "!\na=1\nb=2\n");
  await absorbed(session, "/w.conf");
  assert.deepEqual(changes.flatMap(c => c.edits ?? []), [{ source: id, path: "c", outcome: "conflicted", reason: "unwritable" }]);
  session.close();
});

// ---- Part D: delete (FR-009, FR-010) ----
// Removing W1 takes its whole lines: `  W1:⏎` and `    height: 3.2⏎`, bytes 7-28, so the range is 7-29.

const remove = (session: Session, path: string, location = "/g/walls.yaml") => session.stage(location, { op: "remove", path });
const WITHOUT_W1 = "walls:\n  W2:\n    height: 3.2\n"; // 7 + 22 = 29 bytes

test("FR-009, write-back.md: walls.yaml loses W1, and the edit is bytes 7-29 with no value", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  assert.deepEqual(await remove(session, "/walls/W1"), { ok: true });
  const [edit] = session.index();
  assert.deepEqual([edit?.op, edit?.path, edit?.start, edit?.end, edit?.status], ["remove", "/walls/W1", 7, 29, "staged"]);
  assert.equal("value" in (edit ?? {}), false);
  assert.equal(await previewText(session, "/g/walls.yaml"), WITHOUT_W1);
  assert.equal((await session.preview(idOf(session, "/g/walls.yaml")))?.bytes.length, 29);
  const report = await session.commit();
  assert.deepEqual(report.sources.map(s => [s.outcome, s.edits]), [["written", [{ path: "/walls/W1", outcome: "written" }]]]);
  assert.equal(await read(memory, "/g/walls.yaml"), WITHOUT_W1); // L3: 0-6 and 29-50 of the old file, nothing else
  session.close();
});

test("FR-016, write-back.md: walls.yaml gains W3 whole and loses W1, in one commit", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  await add(session, "/walls/W3", wall(3.2));
  await remove(session, "/walls/W1");
  assert.deepEqual(session.index().map(e => [e.op, e.start, e.end]), [["add", 51, 51], ["remove", 7, 29]]);
  const after = "walls:\n  W2:\n    height: 3.2\n  W3:\n    height: 3.2\n"; // 7 + 22 + 22 = 51 bytes again
  assert.equal(await previewText(session, "/g/walls.yaml"), after);
  await session.commit();
  assert.equal(await read(memory, "/g/walls.yaml"), after);
  session.close();
});

test("FR-009: the writer's own refusals are the staging refusals, verbatim: an absent entry, the whole document", async () => {
  const { session } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  const direct = yamlWriter().open(bytes(WALLS));
  assert.ok(direct.ok);
  for (const path of ["/walls/W9", ""]) {
    const refusal = direct.document.remove?.(path);
    assert.equal(refusal?.ok, false);
    assert.deepEqual(await remove(session, path), { ok: false, reason: refusal?.ok === false ? refusal.reason : "" }, JSON.stringify(path));
  }
  assert.deepEqual(session.index(), []);
  session.close();
});

test("FR-009: a writer whose document has no remove refuses a delete by name", async () => {
  const { session } = await openOn({ "/w.conf": W }, [keyValue]);
  assert.deepEqual(await remove(session, "a", "/w.conf"), { ok: false, reason: "the writer for /w.conf cannot remove: its document has no remove" });
  session.close();
});

test("FR-009: a delete over a staged edit's range is an overlap, refused", async () => {
  const { session } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  await session.stage("/g/walls.yaml", { op: "set", path: "/walls/W1/height", value: 3.4 }); // 25-28 lies inside 7-29
  const result = await remove(session, "/walls/W1");
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /overlaps the staged edit at \/walls\/W1\/height/);
  session.close();
});

test("FR-010: a delete carries over a comment added above it", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  const id = idOf(session, "/g/walls.yaml");
  await remove(session, "/walls/W1");
  const changes = heard(session);
  memory.write("/g/walls.yaml", "# c\n" + WALLS); // 4 bytes: 7-29 becomes 11-33
  await absorbed(session, "/g/walls.yaml");
  assert.deepEqual(changes.flatMap(c => c.edits ?? []), [{ source: id, path: "/walls/W1", outcome: "moved", start: 11, end: 33 }]);
  await session.commit();
  assert.equal(await read(memory, "/g/walls.yaml"), "# c\n" + WITHOUT_W1);
  session.close();
});

test("FR-010: an entry a colleague has already removed makes the delete conflicted `gone`", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  const id = idOf(session, "/g/walls.yaml");
  await remove(session, "/walls/W1");
  const changes = heard(session);
  memory.write("/g/walls.yaml", WITHOUT_W1);
  await absorbed(session, "/g/walls.yaml");
  assert.deepEqual(session.index(), []);
  assert.deepEqual(changes.flatMap(c => c.edits ?? []), [{ source: id, path: "/walls/W1", outcome: "conflicted", reason: "gone" }]);
  session.close();
});

test("FR-010: an entry a colleague has changed makes the delete conflicted `changed`, and the colleague's work stays", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  const id = idOf(session, "/g/walls.yaml");
  await remove(session, "/walls/W1");
  const changes = heard(session);
  const theirs = "walls:\n  W1:\n    height: 3.0\n  W2:\n    height: 3.2\n"; // W1's height 3.2 -> 3.0
  memory.write("/g/walls.yaml", theirs);
  await absorbed(session, "/g/walls.yaml");
  assert.deepEqual(session.index(), []);
  assert.deepEqual(changes.flatMap(c => c.edits ?? []), [{ source: id, path: "/walls/W1", outcome: "conflicted", reason: "changed" }]);
  assert.deepEqual(await session.commit(), { sources: [] });
  assert.equal(await read(memory, "/g/walls.yaml"), theirs);
  session.close();
});

test("FR-010: a commit that meets the colleague's change first reports the source conflicted `changed`", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()], { quiet: true });
  const id = idOf(session, "/g/walls.yaml");
  await remove(session, "/walls/W1");
  memory.write("/g/walls.yaml", "walls:\n  W1:\n    height: 3.0\n  W2:\n    height: 3.2\n");
  assert.deepEqual(await session.commit(), { sources: [{ source: id, location: "/g/walls.yaml", outcome: "conflicted", edits: [{ path: "/walls/W1", outcome: "conflicted", reason: "changed" }] }] });
  session.close();
});

test("FR-010: a change to another entry is no change to this one: the delete still carries over", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  await remove(session, "/walls/W1");
  memory.write("/g/walls.yaml", "walls:\n  W1:\n    height: 3.2\n  W2:\n    height: 9.9\n");
  await absorbed(session, "/g/walls.yaml");
  assert.deepEqual(session.index().map(e => [e.op, e.start, e.end]), [["remove", 7, 29]]);
  await session.commit();
  assert.equal(await read(memory, "/g/walls.yaml"), "walls:\n  W2:\n    height: 9.9\n");
  session.close();
});

// The comparison is the located bytes of the entry's value (what `locate` gives). Two consequences, pinned here
// so the report's claims are witnessed: re-indenting a multi-line entry is a change; a comment added above the
// entry, outside the located value, is not one, and `remove` takes it away with the entry.
test("FR-010: `changed` compares the located value's bytes: a re-indented multi-line entry is changed", async () => {
  const two = "walls:\n  W1:\n    height: 3.2\n    note: x\n  W2:\n    height: 3.2\n";
  const { session, memory } = await openOn({ "/g/walls.yaml": two }, [yamlWriter()]);
  await remove(session, "/walls/W1");
  memory.write("/g/walls.yaml", "walls:\n  W1:\n      height: 3.2\n      note: x\n  W2:\n    height: 3.2\n"); // only the indentation differs
  await absorbed(session, "/g/walls.yaml");
  assert.deepEqual(session.index(), []);
  session.close();
});

test("FR-010: a writer that refuses the removal on the new version makes the delete unwritable", async () => {
  const fickle: Writer = {
    claims: keyValue.claims,
    open: data => {
      const opened = keyValue.open(data);
      if (!opened.ok) return opened;
      const remove = data[0] === 0x21 ? () => ({ ok: false as const, reason: "no longer removable" }) : () => ({ ok: true as const, edit: { start: 0, end: 4, bytes: new Uint8Array() } });
      return { ok: true, document: { ...opened.document, remove } };
    },
  };
  const { session, memory } = await openOn({ "/w.conf": W }, [fickle]);
  const id = idOf(session, "/w.conf");
  assert.deepEqual(await remove(session, "a", "/w.conf"), { ok: true });
  assert.equal(await previewText(session, "/w.conf"), "b=2\n");
  const changes = heard(session);
  memory.write("/w.conf", "!\na=1\nb=2\n");
  await absorbed(session, "/w.conf");
  assert.deepEqual(changes.flatMap(c => c.edits ?? []), [{ source: id, path: "a", outcome: "conflicted", reason: "unwritable" }]);
  session.close();
});

// ---- Part E: edits inside staged edits (FR-011, FR-012) ----

const stagedFor = (path: string) => `the entry at ${path} is staged for removal`;
const entries = (session: Session) => session.index().map(e => [e.op, e.path, e.start, e.end]);
/** What Cascata itself answers for an amend: the staging refusal must be exactly this. */
function amendReason(path: string, value: EditData, operation: Parameters<NonNullable<ReturnType<typeof yamlDocument>["amend"]>>[1]) {
  const result = yamlDocument().amend?.({ path, value }, operation);
  assert.ok(result && result.inside && !result.ok);
  return result.reason;
}
function yamlDocument() {
  const opened = yamlWriter().open(bytes(WALLS));
  assert.ok(opened.ok);
  return opened.document;
}

test("FR-011, staged set, same path: a new set replaces it and goes last; a remove replaces it", async () => {
  const { session } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  await session.stage("/g/walls.yaml", { op: "set", path: "/walls/W1/height", value: 3.4 });
  await session.stage("/g/walls.yaml", { op: "set", path: "/walls/W2/height", value: 3.5 });
  await session.stage("/g/walls.yaml", { op: "set", path: "/walls/W1/height", value: 3.6 });
  assert.deepEqual(session.index().map(e => [e.path, e.value]), [["/walls/W2/height", 3.5], ["/walls/W1/height", 3.6]]);
  await session.unstage("/g/walls.yaml");
  await session.stage("/g/walls.yaml", { op: "set", path: "/walls/W2", value: wall(3.4) });
  assert.deepEqual(await remove(session, "/walls/W2"), { ok: true });
  assert.deepEqual(entries(session), [["remove", "/walls/W2", 29, 51]]); // `  W2:⏎    height: 3.2⏎`, the last two lines
  assert.equal(await previewText(session, "/g/walls.yaml"), "walls:\n  W1:\n    height: 3.2\n");
  session.close();
});

test("FR-011, staged set (a scalar), edit inside: refused, with the writer's own words", async () => {
  const { session } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  await session.stage("/g/walls.yaml", { op: "set", path: "/walls/W2/height", value: 3.4 });
  const operation = { op: "set", path: "/walls/W2/height/x", value: 1 } as const;
  assert.deepEqual(await session.stage("/g/walls.yaml", operation), { ok: false, reason: amendReason("/walls/W2/height", 3.4, operation) });
  assert.deepEqual(entries(session), [["set", "/walls/W2/height", 47, 50]]);
  session.close();
});

test("FR-011, staged set (a container), edit inside: amends the staged value through the writer; the order and the bytes follow", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  const f = (...pairs: [string, number][]) => new Map<string, EditData>(pairs);
  await session.stage("/g/walls.yaml", { op: "set", path: "/walls/W2", value: f(["height", 3.4]) });
  assert.deepEqual(await session.stage("/g/walls.yaml", { op: "set", path: "/walls/W2/height", value: 3.6 }), { ok: true });
  assert.deepEqual(session.index().map(e => [e.op, e.path, e.start, e.end, e.value]), [["set", "/walls/W2", 39, 50, f(["height", 3.6])]]);
  assert.equal(await previewText(session, "/g/walls.yaml"), "walls:\n  W1:\n    height: 3.2\n  W2:\n    height: 3.6\n");
  assert.deepEqual(await session.stage("/g/walls.yaml", { op: "add", path: "/walls/W2/thickness", value: 0.2 }), { ok: true });
  assert.equal(await previewText(session, "/g/walls.yaml"), "walls:\n  W1:\n    height: 3.2\n  W2:\n    height: 3.6\n    thickness: 0.2\n");
  assert.deepEqual(await session.stage("/g/walls.yaml", { op: "remove", path: "/walls/W2/thickness" }), { ok: true });
  assert.equal(await previewText(session, "/g/walls.yaml"), "walls:\n  W1:\n    height: 3.2\n  W2:\n    height: 3.6\n");
  await session.commit();
  assert.equal(await read(memory, "/g/walls.yaml"), "walls:\n  W1:\n    height: 3.2\n  W2:\n    height: 3.6\n");
  session.close();
});

test("FR-011, staged insert, same path: a new set or add amends the insert wholesale, and it keeps its place in staging order", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  await add(session, "/walls/W3", wall(3.2));
  await add(session, "/walls/W4", wall(3.4));
  assert.deepEqual(await session.stage("/g/walls.yaml", { op: "set", path: "/walls/W3", value: wall(3.3) }), { ok: true });
  assert.deepEqual(entries(session), [["add", "/walls/W3", 51, 51], ["add", "/walls/W4", 51, 51]]); // still the first, though restaged
  assert.equal(await previewText(session, "/g/walls.yaml"), WALLS + "  W3:\n    height: 3.3\n" + W4);
  assert.deepEqual(await add(session, "/walls/W3", wall(3.1)), { ok: true });
  assert.equal(await previewText(session, "/g/walls.yaml"), WALLS + "  W3:\n    height: 3.1\n" + W4);
  await session.commit();
  assert.equal(await read(memory, "/g/walls.yaml"), WALLS + "  W3:\n    height: 3.1\n" + W4);
  session.close();
});

test("FR-011, staged insert, same path: removing the inserted entry unstages it", async () => {
  const { session } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  await add(session, "/walls/W3", wall(3.2));
  await add(session, "/walls/W4", wall(3.4));
  assert.deepEqual(await remove(session, "/walls/W3"), { ok: true });
  assert.deepEqual(entries(session), [["add", "/walls/W4", 51, 51]]);
  assert.equal(await previewText(session, "/g/walls.yaml"), WALLS + W4);
  assert.deepEqual(await remove(session, "/walls/W4"), { ok: true });
  assert.deepEqual(session.index(), []);
  assert.equal(await session.preview(idOf(session, "/g/walls.yaml")), undefined);
  assert.deepEqual(await session.commit(), { sources: [] });
  session.close();
});

test("FR-011, staged insert, edit inside: set, add and remove are applied to the staged value, with Cascata's meanings", async () => {
  const { session } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  const f = (...pairs: [string, number][]) => new Map<string, EditData>(pairs);
  await add(session, "/walls/W3", f(["height", 3.2]));
  assert.deepEqual(await session.stage("/g/walls.yaml", { op: "set", path: "/walls/W3/height", value: 3.4 }), { ok: true });
  assert.equal(await previewText(session, "/g/walls.yaml"), WALLS + "  W3:\n    height: 3.4\n");
  assert.deepEqual(await session.stage("/g/walls.yaml", { op: "add", path: "/walls/W3/thickness", value: 0.2 }), { ok: true });
  assert.equal(await previewText(session, "/g/walls.yaml"), WALLS + "  W3:\n    height: 3.4\n    thickness: 0.2\n");
  assert.deepEqual(session.index().map(e => e.value), [f(["height", 3.4], ["thickness", 0.2])]);
  // add creates: an existing key inside the staged value is refused, in Cascata's words
  const again = { op: "add", path: "/walls/W3/thickness", value: 0.3 } as const;
  assert.deepEqual(await session.stage("/g/walls.yaml", again), { ok: false, reason: amendReason("/walls/W3", f(["height", 3.4], ["thickness", 0.2]), again) });
  // set changes: an absent key is refused
  const absent = { op: "set", path: "/walls/W3/nope", value: 1 } as const;
  assert.deepEqual(await session.stage("/g/walls.yaml", absent), { ok: false, reason: amendReason("/walls/W3", f(["height", 3.4], ["thickness", 0.2]), absent) });
  assert.deepEqual(await session.stage("/g/walls.yaml", { op: "remove", path: "/walls/W3/height" }), { ok: true });
  assert.equal(await previewText(session, "/g/walls.yaml"), WALLS + "  W3:\n    thickness: 0.2\n");
  // removing the last key leaves a staged insert of an empty container
  assert.deepEqual(await session.stage("/g/walls.yaml", { op: "remove", path: "/walls/W3/thickness" }), { ok: true });
  assert.deepEqual(session.index().map(e => [e.op, e.value]), [["add", f()]]);
  assert.equal(await previewText(session, "/g/walls.yaml"), WALLS + "  W3: {}\n");
  session.close();
});

test("FR-011, staged delete, same path: a set or an add becomes a set of the entry; a remove replaces it", async () => {
  const { session } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  await remove(session, "/walls/W1");
  // `height: 3.2` under W1 is bytes 17-28
  assert.deepEqual(await add(session, "/walls/W1", wall(3.0)), { ok: true });
  assert.deepEqual(session.index().map(e => [e.op, e.path, e.start, e.end, e.value]), [["set", "/walls/W1", 17, 28, wall(3.0)]]);
  assert.equal(await previewText(session, "/g/walls.yaml"), "walls:\n  W1:\n    height: 3.0\n  W2:\n    height: 3.2\n");
  assert.deepEqual(await remove(session, "/walls/W1"), { ok: true });
  assert.deepEqual(entries(session), [["remove", "/walls/W1", 7, 29]]);
  assert.deepEqual(await session.stage("/g/walls.yaml", { op: "set", path: "/walls/W1", value: wall(2.9) }), { ok: true });
  assert.deepEqual(entries(session), [["set", "/walls/W1", 17, 28]]);
  assert.equal(await previewText(session, "/g/walls.yaml"), "walls:\n  W1:\n    height: 2.9\n  W2:\n    height: 3.2\n");
  session.close();
});

test("FR-011, staged delete, edit inside: refused, the entry is staged for removal", async () => {
  const { session } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  await remove(session, "/walls/W1");
  for (const operation of [
    { op: "set", path: "/walls/W1/height", value: 3.4 },
    { op: "add", path: "/walls/W1/thickness", value: 0.2 },
    { op: "remove", path: "/walls/W1/height" },
  ] as const) {
    assert.deepEqual(await session.stage("/g/walls.yaml", operation), { ok: false, reason: stagedFor("/walls/W1") }, operation.op);
  }
  assert.deepEqual(entries(session), [["remove", "/walls/W1", 7, 29]]);
  session.close();
});

test("FR-012: a path that merely starts like a staged path is beside it, not inside it", async () => {
  const { session } = await openOn({ "/g/walls.yaml": "walls:\n  W3:\n    height: 3.2\n  W30:\n    height: 3.2\n" }, [yamlWriter()]);
  await remove(session, "/walls/W3");
  assert.deepEqual(await session.stage("/g/walls.yaml", { op: "set", path: "/walls/W30/height", value: 3.4 }), { ok: true });
  assert.equal(session.index().length, 2);
  session.close();
});

test("FR-011: an amended insert is rebased with its amended value", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": WALLS }, [yamlWriter()]);
  await add(session, "/walls/W3", wall(3.2));
  await session.stage("/g/walls.yaml", { op: "set", path: "/walls/W3/height", value: 3.4 });
  memory.write("/g/walls.yaml", "# c\n" + WALLS);
  await absorbed(session, "/g/walls.yaml");
  assert.deepEqual(entries(session), [["add", "/walls/W3", 55, 55]]);
  await session.commit();
  assert.equal(await read(memory, "/g/walls.yaml"), "# c\n" + WALLS + "  W3:\n    height: 3.4\n");
  session.close();
});

/** A toy with an `add` and a `write` that knows only top-level keys: its documents answer neither `inside` nor `amend`. */
const plain = (extra: { inside?: boolean } = {}): Writer => ({
  claims: keyValue.claims,
  open: data => {
    const opened = keyValue.open(data);
    if (!opened.ok) return opened;
    const add = (path: string) => ({ ok: true as const, edit: { start: data.length, end: data.length, bytes: bytes(`${path}=0\n`) } });
    return { ok: true, document: { ...opened.document, add, ...(extra.inside ? { inside: (path: string, within: string) => path.startsWith(`${within}/`) } : {}) } };
  },
});

test("FR-012: a writer without inside or amend: nothing is inside anything; the writer's refusal stands, naming the missing capability", async () => {
  const { session } = await openOn({ "/w.conf": W }, [plain()]);
  assert.deepEqual(await add(session, "c", "3", "/w.conf"), { ok: true });
  const result = await session.stage("/w.conf", { op: "set", path: "c/x", value: "1" });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /^no key c\/x; .*inside/);
  // with no insert staged, the writer's refusal is verbatim
  await session.unstage("/w.conf");
  assert.deepEqual(await session.stage("/w.conf", { op: "set", path: "c/x", value: "1" }), { ok: false, reason: "no key c/x" });
  session.close();
});

test("FR-012: a writer that answers inside but not amend refuses an edit inside a staged edit by name", async () => {
  const { session } = await openOn({ "/w.conf": W }, [plain({ inside: true })]);
  await add(session, "c", "3", "/w.conf");
  assert.deepEqual(await session.stage("/w.conf", { op: "set", path: "c/x", value: "1" }), { ok: false, reason: "the writer for /w.conf cannot amend the staged edit at c: its document has no amend" });
  assert.deepEqual(await session.stage("/w.conf", { op: "set", path: "b", value: "9" }), { ok: true }); // beside it, fine
  session.close();
});

// ---- Part F: the shift guard (FR-013, FR-014) ----
// LIST: `walls:⏎` 0-6, then each item is `  - id: Wn⏎` (11 bytes) and `    height: 3.2⏎` (16): item 0 at 7-33,
// item 1 at 34-60, the second height's `3.2` at 57-60. 61 bytes.

const LIST = "walls:\n  - id: W1\n    height: 3.2\n  - id: W2\n    height: 3.2\n";
const TOP = "  - id: W0\n    height: 3.0\n"; // 27 bytes, added by a colleague above the first item: index 1 now names W1
const withTop = "walls:\n" + TOP + LIST.slice(7);
const shifts = (changes: Change[]) => changes.flatMap(c => c.edits ?? []).map(e => [e.path, e.outcome, e.reason]);

test("FR-013: a set through a list that gained an item is conflicted `shifted`, not moved onto the wrong item", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": LIST }, [yamlWriter()]);
  assert.deepEqual(await session.stage("/g/walls.yaml", { op: "set", path: "/walls/1/height", value: 3.4 }), { ok: true });
  assert.deepEqual(entries(session), [["set", "/walls/1/height", 57, 60]]);
  const changes = heard(session);
  memory.write("/g/walls.yaml", withTop);
  await absorbed(session, "/g/walls.yaml");
  assert.deepEqual(session.index(), []);
  assert.deepEqual(shifts(changes), [["/walls/1/height", "conflicted", "shifted"]]);
  assert.deepEqual(await session.commit(), { sources: [] });
  assert.equal(await read(memory, "/g/walls.yaml"), withTop);
  session.close();
});

test("FR-013: an insert and a delete through the list are conflicted `shifted` too", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": LIST }, [yamlWriter()]);
  assert.deepEqual(await add(session, "/walls/1/thickness", 0.2), { ok: true });
  assert.deepEqual(await remove(session, "/walls/0"), { ok: true });
  const changes = heard(session);
  memory.write("/g/walls.yaml", withTop);
  await absorbed(session, "/g/walls.yaml");
  assert.deepEqual(session.index(), []);
  assert.deepEqual(shifts(changes), [["/walls/1/thickness", "conflicted", "shifted"], ["/walls/0", "conflicted", "shifted"]]);
  session.close();
});

test("FR-013: a commit that meets the shifted list first reports the source conflicted `shifted`", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": LIST }, [yamlWriter()], { quiet: true });
  const id = idOf(session, "/g/walls.yaml");
  await session.stage("/g/walls.yaml", { op: "set", path: "/walls/1/height", value: 3.4 });
  memory.write("/g/walls.yaml", withTop);
  assert.deepEqual(await session.commit(), { sources: [{ source: id, location: "/g/walls.yaml", outcome: "conflicted", edits: [{ path: "/walls/1/height", outcome: "conflicted", reason: "shifted" }] }] });
  assert.equal(await read(memory, "/g/walls.yaml"), withTop);
  session.close();
});

// MIXED: `walls:⏎` 0-6, `  W1:⏎` 7-12, `    height: 3.2⏎` 13-28 (3.2 at 25-28), `tags:⏎` 29-34, `  - a⏎` 35-40, `  - b⏎` 41-46.
const MIXED = "walls:\n  W1:\n    height: 3.2\ntags:\n  - a\n  - b\n";

test("FR-013: a set on /walls/W1/height is not shifted by a list elsewhere that changed length", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": MIXED }, [yamlWriter()]);
  await session.stage("/g/walls.yaml", { op: "set", path: "/walls/W1/height", value: 3.4 });
  const changes = heard(session);
  memory.write("/g/walls.yaml", "walls:\n  W1:\n    height: 3.2\ntags:\n  - z\n  - a\n  - b\n");
  await absorbed(session, "/g/walls.yaml");
  assert.deepEqual(session.index().map(e => [e.path, e.start, e.end, e.status]), [["/walls/W1/height", 25, 28, "staged"]]);
  assert.deepEqual(shifts(changes), []);
  session.close();
});

test("FR-013: an edit of an item is shifted by that list gaining an item, and not by an item of it changing in place", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": MIXED }, [yamlWriter()]);
  await session.stage("/g/walls.yaml", { op: "set", path: "/tags/1", value: "B" });
  assert.deepEqual(entries(session), [["set", "/tags/1", 45, 46]]);
  memory.write("/g/walls.yaml", "walls:\n  W1:\n    height: 3.2\ntags:\n  - z\n  - b\n"); // same length: item 0 changed
  await absorbed(session, "/g/walls.yaml");
  assert.deepEqual(entries(session), [["set", "/tags/1", 45, 46]]);
  const changes = heard(session);
  memory.write("/g/walls.yaml", "walls:\n  W1:\n    height: 3.2\ntags:\n  - z\n  - a\n  - b\n"); // grew
  await absorbed(session, "/g/walls.yaml");
  assert.deepEqual(session.index(), []);
  assert.deepEqual(shifts(changes), [["/tags/1", "conflicted", "shifted"]]);
  session.close();
});

test("FR-013: an append (`-`) is never shifted: it goes after whatever the list now holds", async () => {
  const { session, memory } = await openOn({ "/g/walls.yaml": MIXED }, [yamlWriter()]);
  await add(session, "/tags/-", "c");
  assert.deepEqual(entries(session), [["add", "/tags/-", 47, 47]]);
  memory.write("/g/walls.yaml", MIXED + "  - z\n"); // the list grew by an append of someone else's
  await absorbed(session, "/g/walls.yaml");
  assert.deepEqual(entries(session), [["add", "/tags/-", 53, 53]]);
  await session.commit();
  assert.equal(await read(memory, "/g/walls.yaml"), MIXED + "  - z\n  - c\n");
  session.close();
});

test("FR-013: the session asks the base document `shifted(path, newer)`, with the new version opened; a writer without it has no guard", async () => {
  const asked: [string, boolean][] = [];
  const guarded: Writer = {
    claims: keyValue.claims,
    open: data => {
      const opened = keyValue.open(data);
      if (!opened.ok) return opened;
      return { ok: true, document: { ...opened.document, shifted: (path, newer) => (asked.push([path, newer.locate("b").ok && newer.locate("a").ok]), path === "b") } };
    },
  };
  const { session, memory } = await openOn({ "/w.conf": W }, [guarded]);
  const id = idOf(session, "/w.conf");
  await session.stage("/w.conf", { op: "set", path: "a", value: "7" });
  await session.stage("/w.conf", { op: "set", path: "b", value: "8" });
  const changes = heard(session);
  memory.write("/w.conf", "# note\na=1\nb=2\n");
  await absorbed(session, "/w.conf");
  assert.deepEqual(asked, [["a", true], ["b", true]]); // asked of each edit, with a document of the new bytes
  assert.deepEqual(changes.flatMap(c => c.edits ?? []).map(e => [e.path, e.outcome, e.reason]), [["a", "moved", undefined], ["b", "conflicted", "shifted"]]);
  assert.equal(changes[0]?.edits?.[0]?.source, id);
  const unguarded = await openOn({ "/w.conf": W }, [keyValue]);
  await unguarded.session.stage("/w.conf", { op: "set", path: "b", value: "8" });
  unguarded.memory.write("/w.conf", "# note\na=1\nb=2\n");
  await absorbed(unguarded.session, "/w.conf");
  assert.equal(unguarded.session.index().length, 1);
  unguarded.session.close();
  session.close();
});

// ---- The rollback, and a real disk (FR-016, the handoff's snapshot rule) ----

test("a rolled-back batch restores the opened document with the edits: a later stage is against the old base", async () => {
  const throwing: Handler = {
    claims: location => location.endsWith(".md"),
    analyze(source) {
      if (source.includes("BOOM")) throw new Error("handler broke");
      return { requests: [] };
    },
  };
  const memory = createMemoryHost({ "/g/walls.yaml": WALLS, "/n.md": "fine\n" });
  const session = await openSession({ host: memory, entry: "/g/walls.yaml", handlers: [throwing], writers: [yamlWriter()], writable: ["/"] });
  await session.addRoot("/n.md");
  await add(session, "/walls/W3", wall(3.2));
  const before = session.index();
  const seen = await unhandled(async () => {
    memory.write("/g/walls.yaml", "# c\n" + WALLS); // rebased first ...
    memory.write("/n.md", "BOOM\n"); // ... then the batch throws, and is rolled back
    await tick();
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(session.index(), before);
  assert.deepEqual(entries(session), [["add", "/walls/W3", 51, 51]]);
  // The opened document went back with the base: this edit is located in the old bytes (25-28), not the new (29-32).
  assert.deepEqual(await session.stage("/g/walls.yaml", { op: "set", path: "/walls/W1/height", value: 3.4 }), { ok: true });
  assert.deepEqual(entries(session), [["add", "/walls/W3", 51, 51], ["set", "/walls/W1/height", 25, 28]]);
  assert.equal(await previewText(session, "/g/walls.yaml"), "walls:\n  W1:\n    height: 3.4\n  W2:\n    height: 3.2\n" + W3);
  session.close();
});

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test("on a real disk: an insert and a delete survive a comment added by another process, and land in the file", async t => {
  const dir = await scratch(t, "provenance-insdel-");
  const file = path.join(dir, "walls.yaml");
  await fs.writeFile(file, WALLS);
  const session = closing(t, await openSession({ host: createNodeHost({ debounce: 50 }), entry: file, handlers: [], writers: [yamlWriter()], writable: [dir] }));
  await sleep(100); // let the platform's watchers start before the test writes
  const changes: Change[] = [];
  session.onChange(c => changes.push(c));
  assert.deepEqual(await add(session, "/walls/W3", wall(3.2), file), { ok: true });
  assert.deepEqual(await remove(session, "/walls/W1", file), { ok: true });
  await fs.writeFile(file, "# from survey\n" + WALLS); // 14 bytes
  for (let waited = 0; changes.length === 0 && waited < 5000; waited += 25) await sleep(25);
  assert.deepEqual(entries(session), [["add", "/walls/W3", 65, 65], ["remove", "/walls/W1", 21, 43]]);
  const report = await session.commit();
  assert.deepEqual(report.sources.map(s => [s.outcome, s.edits.map(e => e.outcome)]), [["written", ["written", "written"]]]);
  assert.equal(await fs.readFile(file, "utf8"), "# from survey\n" + "walls:\n  W2:\n    height: 3.2\n" + W3);
  assert.deepEqual(await fs.readdir(dir), ["walls.yaml"]);
});
