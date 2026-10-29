import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { yamlWriter } from "@egildo/cascata/writers";
import { openSession } from "../src/index.ts";
import type { EditData, Host, Session, Writer } from "../src/index.ts";
import { createMemoryHost } from "../src/memory.ts";
import { absorbed, keyValue } from "./helpers.ts";

// The saveable index (specs/saveable-index/spec.md). Every expected value is counted by hand.
//
// /g/a.yaml is `x: 1⏎y: 2⏎`, 10 bytes: x's value at 3-4, y's at 8-9.
// /g/walls.yaml is write-back.md's 51 bytes; W1's height 3.2 sits at 25-28, and an append lands at 51-51.

const A = "x: 1\ny: 2\n";
const WALLS = "walls:\n  W1:\n    height: 3.2\n  W2:\n    height: 3.2\n";
const W3 = "  W3:\n    height: 3.2\n";
const W4 = "  W4:\n    height: 3.4\n";
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);
const sha = (value: string) => createHash("sha256").update(bytes(value)).digest("hex");
const wall = (height: number) => new Map<string, EditData>([["height", height]]);
const quiet = (memory: ReturnType<typeof createMemoryHost>): Host => ({ ...memory, watch: () => ({ set: () => undefined, close: () => undefined }) });

async function openOn(memory: ReturnType<typeof createMemoryHost>, entry: string, writers: readonly Writer[] = [yamlWriter()], roots: readonly string[] = []) {
  const session = await openSession({ host: memory, entry, handlers: [], writers, writable: ["/"] });
  for (const root of roots) await session.addRoot(root);
  return session;
}
const previewText = async (session: Session, location: string) => {
  const source = session.sources().find(s => s.location === location);
  assert.ok(source);
  return text((await session.preview(source.id))?.bytes ?? new Uint8Array());
};
const read = async (memory: Host, location: string) => {
  const result = await memory.read(location);
  assert.ok(result.ok);
  return text(result.bytes);
};

// ---- Part A: saving (FR-001 to FR-004) ----

test("FR-002: an empty index saves as no sources", async () => {
  const session = await openOn(createMemoryHost({ "/g/a.yaml": A }), "/g/a.yaml");
  assert.deepEqual(session.save(), { format: 1, sources: [] });
  session.close();
});

test("FR-002: a save is the location, the base version, the base bytes, and each edit's operation, path, value and status, in staging order, with no byte ranges", async () => {
  const session = await openOn(createMemoryHost({ "/g/walls.yaml": WALLS, "/g/a.yaml": A }), "/g/walls.yaml", [yamlWriter()], ["/g/a.yaml"]);
  await session.stage("/g/walls.yaml", { op: "set", path: "/walls/W1/height", value: 3.4 });
  await session.stage("/g/a.yaml", { op: "set", path: "/y", value: 9 });
  await session.stage("/g/walls.yaml", { op: "add", path: "/walls/W3", value: wall(3.2) });
  await session.stage("/g/walls.yaml", { op: "remove", path: "/walls/W2" });
  assert.deepEqual(session.save(), {
    format: 1,
    sources: [
      {
        location: "/g/walls.yaml",
        base: sha(WALLS),
        bytes: bytes(WALLS),
        edits: [
          { op: "set", path: "/walls/W1/height", value: 3.4, status: "staged" },
          { op: "add", path: "/walls/W3", value: wall(3.2), status: "staged" },
          { op: "remove", path: "/walls/W2", status: "staged" },
        ],
      },
      { location: "/g/a.yaml", base: sha(A), bytes: bytes(A), edits: [{ op: "set", path: "/y", value: 9, status: "staged" }] },
    ],
  });
  session.close();
});

test("FR-001: the save is plain data: it survives a structured clone unchanged, and saving changes nothing", async () => {
  const session = await openOn(createMemoryHost({ "/g/walls.yaml": WALLS }), "/g/walls.yaml");
  await session.stage("/g/walls.yaml", { op: "add", path: "/walls/W3", value: wall(3.2) });
  const before = session.index();
  const saved = session.save();
  assert.deepEqual(structuredClone(saved), saved);
  assert.deepEqual(session.index(), before);
  assert.equal(await previewText(session, "/g/walls.yaml"), WALLS + W3);
  session.close();
});

test("FR-001: the saved bytes are the save's own: writing into them does not reach the session's base", async () => {
  const session = await openOn(createMemoryHost({ "/g/a.yaml": A }), "/g/a.yaml");
  await session.stage("/g/a.yaml", { op: "set", path: "/x", value: 7 });
  const saved = session.save();
  saved.sources[0]?.bytes.fill(0x7a);
  assert.equal(await previewText(session, "/g/a.yaml"), "x: 7\ny: 2\n");
  assert.deepEqual(session.save().sources[0]?.bytes, bytes(A));
  session.close();
});

test("FR-003: an overriding edit is saved with its status, its disk bytes, and the base it was rebased onto", async () => {
  const memory = createMemoryHost({ "/g/a.yaml": A });
  const session = await openOn(memory, "/g/a.yaml");
  await session.stage("/g/a.yaml", { op: "set", path: "/x", value: 7 });
  memory.write("/g/a.yaml", "x: 5\ny: 2\n"); // the colleague changed the same value
  await absorbed(session, "/g/a.yaml");
  assert.deepEqual(session.save(), {
    format: 1,
    sources: [{ location: "/g/a.yaml", base: sha("x: 5\ny: 2\n"), bytes: bytes("x: 5\ny: 2\n"), edits: [{ op: "set", path: "/x", value: 7, status: "overrides", disk: bytes("5") }] }],
  });
  session.close();
});

test("FR-004: a waiting source is saved as any other: its edits against its base, not the unreadable disk", async () => {
  const picky: Writer = { claims: keyValue.claims, open: data => (data[0] === 0x21 ? { ok: false, reason: "not a conf file" } : keyValue.open(data)) };
  const memory = createMemoryHost({ "/w.conf": "a=1\nb=2\n" });
  const session = await openOn(memory, "/w.conf", [picky]);
  await session.stage("/w.conf", { op: "set", path: "a", value: "7" });
  memory.write("/w.conf", "!\na=1\nb=2\n");
  await absorbed(session, "/w.conf");
  assert.equal(session.index()[0]?.waiting, "not a conf file"); // precondition: it waits
  assert.deepEqual(session.save(), {
    format: 1,
    sources: [{ location: "/w.conf", base: sha("a=1\nb=2\n"), bytes: bytes("a=1\nb=2\n"), edits: [{ op: "set", path: "a", value: "7", status: "staged" }] }],
  });
  session.close();
});
