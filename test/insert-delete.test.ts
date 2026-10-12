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
