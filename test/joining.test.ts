import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createOrigin, editTarget, load, parse } from "@egildo/cascata";
import type { Node } from "@egildo/cascata";
import { yamlWriter } from "@egildo/cascata/writers";
import { openSession } from "../src/index.ts";
import type { Change, Host, Session, Writer } from "../src/index.ts";
import { createMemoryHost } from "../src/memory.ts";
import { absorbed, byLocation } from "./helpers.ts";

// The walking skeleton, end to end (specs/joining/spec.md): Cascata's writers and `editTarget` in
// Provenance's editing stage, over the geometry fixture. The expected bytes are copied from
// docs/write-back.md's "Cases on paper", where they were counted by hand; none comes from a run.

const fixture = (name: string) => readFileSync(new URL(`./fixtures/geometry/${name}`, import.meta.url), "utf8");
const bytes = (text: string) => new TextEncoder().encode(text);
// ignoreBOM: true, or the decoder swallows a leading byte-order mark and case 8 cannot see it.
const text = (data: Uint8Array) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(data);

/** write-back.md's file: 51 bytes, W1's height `3.2` at 25-28, W2's at 47-50. */
const WALLS = fixture("walls.yaml");

/** The node at an RFC 6901 pointer in a tree, as Cascata read it. */
function at(tree: Node, pointer: string): Node {
  let node = tree;
  for (const segment of pointer.split("/").slice(1)) {
    assert.equal(node.type, "mapping", `${pointer}: no mapping at ${segment}`);
    const next: Node | undefined = node.type === "mapping" ? node.entries.get(segment) : undefined;
    assert.ok(next, `${pointer}: no ${segment}`);
    node = next;
  }
  return node;
}

/** Cascata reads a document's bytes and answers the scalar at a pointer: its kind and value (L2). */
function read(data: Uint8Array, pointer: string): [string, unknown] {
  const parsed = parse(data, { origin: createOrigin("doc.yaml", "doc.yaml") });
  assert.ok(parsed.ok, "the committed file must still be a document Cascata reads");
  const node = at(parsed.tree, pointer);
  assert.equal(node.type, "scalar");
  return node.type === "scalar" ? [node.kind, node.value] : ["", undefined];
}

/** L3: every byte outside [start, end) is unchanged, and `after` is `before` with that range replaced by `replacement`. */
function onlyTheValueMoved(before: string, after: string, start: number, end: number, replacement: string) {
  const b = bytes(before);
  const a = bytes(after);
  const r = bytes(replacement);
  assert.deepEqual(a.slice(0, start), b.slice(0, start), "bytes before the edit");
  assert.deepEqual(a.slice(start, start + r.length), r, "the edit's bytes");
  assert.deepEqual(a.slice(start + r.length), b.slice(end), "bytes after the edit");
}

/** A memory host that counts the writes it is asked to make. */
function spied(memory: ReturnType<typeof createMemoryHost>) {
  const writes: string[] = [];
  const host: Host = {
    ...memory,
    async write(location, data) {
      writes.push(location);
      return memory.write(location, data);
    },
  };
  return { host, writes };
}

async function openWalls(content: string, writers: readonly Writer[] = [yamlWriter()], writable: readonly string[] = ["/g"]) {
  const memory = createMemoryHost({ "/g/walls.yaml": content });
  const { host, writes } = spied(memory);
  const session = await openSession({ host, entry: "/g/walls.yaml", handlers: [], writers, writable });
  return { memory, session, writes };
}

const disk = async (memory: Host, location = "/g/walls.yaml") => {
  const result = await memory.read(location);
  assert.ok(result.ok);
  return text(result.bytes);
};

const edited = (height: string, w1 = "3.2") => `walls:\n  W1:\n    height: ${w1}\n  W2:\n    height: ${height}\n`;

test("the fixture is the file write-back.md counted: 51 bytes, with the heights where it says", () => {
  assert.equal(bytes(WALLS).length, 51);
  assert.equal(WALLS.slice(25, 28), "3.2");
  assert.equal(WALLS.slice(47, 50), "3.2");
});

test("case 1: set W2's height to 3.4; only bytes 47-50 change, and Cascata reads a decimal 3.4", async () => {
  const { memory, session } = await openWalls(WALLS);
  assert.deepEqual(await session.stage("/g/walls.yaml", "/walls/W2/height", 3.4), { ok: true });
  assert.deepEqual(session.index().map(e => [e.start, e.end]), [[47, 50]]);
  await session.commit();
  const after = await disk(memory);
  assert.equal(after, edited("3.4"));
  onlyTheValueMoved(WALLS, after, 47, 50, "3.4");
  assert.deepEqual(read(bytes(after), "/walls/W2/height"), ["float", 3.4]);
  session.close();
});

test("case 2: nothing staged, commit writes nothing, and the file is its 51 bytes", async () => {
  const { memory, session, writes } = await openWalls(WALLS);
  assert.deepEqual(await session.commit(), { sources: [] });
  assert.deepEqual(writes, []);
  assert.equal(await disk(memory), WALLS);
  session.close();
});

test("case 3: a comment added above moves the edit to 69-72, and the comment is kept", async () => {
  const { memory, session } = await openWalls(WALLS);
  await session.stage("/g/walls.yaml", "/walls/W2/height", 3.4);
  const note = "# from survey 2026-09\n"; // 22 bytes
  assert.equal(bytes(note).length, 22);
  memory.write("/g/walls.yaml", note + WALLS);
  await absorbed(session, "/g/walls.yaml");
  assert.deepEqual(session.index().map(e => [e.start, e.end, e.status]), [[69, 72, "staged"]]);
  await session.commit();
  const after = await disk(memory);
  assert.equal(after, note + edited("3.4"));
  onlyTheValueMoved(note + WALLS, after, 69, 72, "3.4");
  assert.deepEqual(read(bytes(after), "/walls/W2/height"), ["float", 3.4]);
  session.close();
});

test("case 4: the same value changed on disk is overridden, and the session is told it overrode 3.6", async () => {
  const { memory, session } = await openWalls(WALLS);
  const changes: Change[] = [];
  session.onChange(c => changes.push(c));
  await session.stage("/g/walls.yaml", "/walls/W2/height", 3.4);
  memory.write("/g/walls.yaml", edited("3.6"));
  await absorbed(session, "/g/walls.yaml");
  assert.deepEqual(session.index().map(e => [e.status, text(e.disk ?? new Uint8Array())]), [["overrides", "3.6"]]);
  assert.deepEqual(changes.flatMap(c => c.edits ?? []).map(e => [e.outcome, text(e.disk ?? new Uint8Array())]), [["overrides", "3.6"]]);
  const report = await session.commit();
  assert.deepEqual(report.sources[0]?.edits.map(e => [e.outcome, text(e.disk ?? new Uint8Array())]), [["overrode", "3.6"]]);
  assert.equal(await disk(memory), edited("3.4"));
  session.close();
});

test("case 5: a colleague's change to W1 is kept, and W2 gets 3.4", async () => {
  const { memory, session } = await openWalls(WALLS);
  await session.stage("/g/walls.yaml", "/walls/W2/height", 3.4);
  memory.write("/g/walls.yaml", edited("3.2", "3.0"));
  await absorbed(session, "/g/walls.yaml");
  await session.commit();
  const after = await disk(memory);
  assert.equal(after, edited("3.4", "3.0"));
  assert.deepEqual(read(bytes(after), "/walls/W1/height"), ["float", 3.0]);
  assert.deepEqual(read(bytes(after), "/walls/W2/height"), ["float", 3.4]);
  session.close();
});

test("case 6: a colleague deletes W2: the edit is dropped, reported, and nothing is written for it", async () => {
  const { memory, session, writes } = await openWalls(WALLS);
  const changes: Change[] = [];
  session.onChange(c => changes.push(c));
  await session.stage("/g/walls.yaml", "/walls/W2/height", 3.4);
  const withoutW2 = "walls:\n  W1:\n    height: 3.2\n";
  memory.write("/g/walls.yaml", withoutW2);
  await absorbed(session, "/g/walls.yaml");
  assert.deepEqual(session.index(), []);
  assert.deepEqual(changes.flatMap(c => c.edits ?? []).map(e => [e.path, e.outcome]), [["/walls/W2/height", "conflicted"]]);
  assert.deepEqual(await session.commit(), { sources: [] });
  assert.deepEqual(writes, []);
  assert.equal(await disk(memory), withoutW2);
  session.close();
});

test("case 7: CRLF line endings: W1's height is at 27-30, and every CRLF stays", async () => {
  const crlf = WALLS.replaceAll("\n", "\r\n");
  assert.equal(crlf.slice(27, 30), "3.2");
  const { memory, session } = await openWalls(crlf);
  await session.stage("/g/walls.yaml", "/walls/W1/height", 3.4);
  assert.deepEqual(session.index().map(e => [e.start, e.end]), [[27, 30]]);
  await session.commit();
  const after = await disk(memory);
  assert.equal(after, edited("3.2", "3.4").replaceAll("\n", "\r\n"));
  onlyTheValueMoved(crlf, after, 27, 30, "3.4");
  assert.deepEqual(read(bytes(after), "/walls/W1/height"), ["float", 3.4]);
  session.close();
});

test("case 8: a byte-order mark: W1's height is at 28-31, and the mark is still there", async () => {
  const marked = "﻿" + WALLS;
  assert.deepEqual([...bytes(marked).slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const { memory, session } = await openWalls(marked);
  await session.stage("/g/walls.yaml", "/walls/W1/height", 3.4);
  assert.deepEqual(session.index().map(e => [e.start, e.end]), [[28, 31]]);
  await session.commit();
  const after = await disk(memory);
  assert.equal(after, "﻿" + edited("3.2", "3.4"));
  assert.deepEqual([...bytes(after).slice(0, 3)], [0xef, 0xbb, 0xbf]);
  onlyTheValueMoved(marked, after, 28, 31, "3.4");
  session.close();
});

test("case 9: the integer 3 over a decimal is written 3.0, so the value read back is still a decimal", async () => {
  const { memory, session } = await openWalls(WALLS);
  await session.stage("/g/walls.yaml", "/walls/W1/height", 3);
  await session.commit();
  const after = await disk(memory);
  assert.equal(after, edited("3.2", "3.0"));
  assert.deepEqual(read(bytes(after), "/walls/W1/height"), ["float", 3]);
  session.close();
});

test("case 10: a string that now needs quotes is written quoted, and reads back as that string", async () => {
  const withNote = "walls:\n  W1:\n    height: 3.2\n    note: north side\n  W2:\n    height: 3.2\n";
  assert.equal(withNote.slice(39, 49), "north side");
  const { memory, session } = await openWalls(withNote);
  await session.stage("/g/walls.yaml", "/walls/W1/note", "north: side");
  assert.deepEqual(session.index().map(e => [e.start, e.end]), [[39, 49]]);
  await session.commit();
  const after = await disk(memory);
  assert.equal(after, withNote.replace("north side", '"north: side"'));
  onlyTheValueMoved(withNote, after, 39, 49, '"north: side"');
  assert.deepEqual(read(bytes(after), "/walls/W1/note"), ["string", "north: side"]);
  session.close();
});

// Keep the imports honest for the cascade tests added next.
void byLocation;
void load;
void editTarget;
