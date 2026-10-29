import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { yamlWriter } from "@egildo/cascata/writers";
import { openSession } from "../src/index.ts";
import type { Change, EditData, Host, SavedIndex, Session, Writer } from "../src/index.ts";
import { createMemoryHost } from "../src/memory.ts";
import { absorbed, keyValue, keyValueShot, opened } from "./helpers.ts";

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

// ---- Part B: restoring (FR-005 to FR-009) ----

const heard = (session: Session) => {
  const changes: Change[] = [];
  session.onChange(change => changes.push(change));
  return changes;
};
const notices = (changes: readonly Change[]) => changes.flatMap(c => c.edits ?? []);
const idOf = (session: Session, location: string) => {
  const source = session.sources().find(s => s.location === location);
  assert.ok(source);
  return source.id;
};

/** A writer over `.conf` files that throws on a value of BOOM: the writer bug of case 12. */
const bomb: Writer = opened({
  ...keyValueShot,
  write(data, path, value) {
    if (value === "BOOM") throw new Error("writer broke");
    return keyValueShot.write(data, path, value);
  },
});

for (const [name, through] of [
  ["as saved", (saved: SavedIndex) => saved],
  ["case 11: through structuredClone", (saved: SavedIndex) => structuredClone(saved)],
] as const) {
  test(`case 1, ${name}: the disk unchanged: restored, and index() and the preview equal the old session's, byte ranges included`, async () => {
    const memory = createMemoryHost({ "/g/walls.yaml": WALLS });
    const first = await openOn(memory, "/g/walls.yaml");
    await first.stage("/g/walls.yaml", { op: "set", path: "/walls/W1/height", value: 3.4 });
    await first.stage("/g/walls.yaml", { op: "add", path: "/walls/W3", value: wall(3.2) });
    assert.deepEqual(first.index().map(e => [e.path, e.start, e.end]), [["/walls/W1/height", 25, 28], ["/walls/W3", 51, 51]]); // precondition
    const second = await openOn(memory, "/g/walls.yaml");
    const changes = heard(second);
    assert.deepEqual(await second.restore(through(first.save())), {
      outcome: "restored",
      sources: [{ location: "/g/walls.yaml", outcome: "restored", edits: [{ path: "/walls/W1/height", outcome: "restored" }, { path: "/walls/W3", outcome: "restored" }] }],
    });
    assert.deepEqual(second.index(), first.index());
    assert.equal(await previewText(second, "/g/walls.yaml"), await previewText(first, "/g/walls.yaml"));
    assert.equal(await previewText(second, "/g/walls.yaml"), "walls:\n  W1:\n    height: 3.4\n  W2:\n    height: 3.2\n" + W3);
    assert.deepEqual(notices(changes), []); // nothing moved, so there is nothing to tell
    first.close();
    second.close();
  });
}

test("case 2: a colleague added a line above while the page was closed: restored, rebased, `moved`, and the commit writes it in the new place", async () => {
  const memory = createMemoryHost({ "/g/a.yaml": A });
  const first = await openOn(memory, "/g/a.yaml");
  await first.stage("/g/a.yaml", { op: "set", path: "/x", value: 7 });
  const saved = first.save();
  first.close();
  memory.write("/g/a.yaml", "# c\n" + A); // 4 bytes: x's value moves from 3-4 to 7-8
  const second = await openOn(memory, "/g/a.yaml");
  const changes = heard(second);
  const report = await second.restore(saved);
  assert.equal(report.sources[0]?.outcome, "restored");
  assert.deepEqual(notices(changes), [{ source: idOf(second, "/g/a.yaml"), path: "/x", outcome: "moved", start: 7, end: 8 }]);
  assert.deepEqual(second.index().map(e => [e.base, e.start, e.end, e.status]), [[sha("# c\n" + A), 7, 8, "staged"]]);
  await second.commit();
  assert.equal(await read(memory, "/g/a.yaml"), "# c\nx: 7\ny: 2\n");
  second.close();
});

test("case 3: a colleague changed the same value: restored, and the notice is `overrides` with the colleague's bytes", async () => {
  const memory = createMemoryHost({ "/g/a.yaml": A });
  const first = await openOn(memory, "/g/a.yaml");
  await first.stage("/g/a.yaml", { op: "set", path: "/x", value: 7 });
  const saved = first.save();
  first.close();
  memory.write("/g/a.yaml", "x: 5\ny: 2\n");
  const second = await openOn(memory, "/g/a.yaml");
  const changes = heard(second);
  await second.restore(saved);
  assert.deepEqual(notices(changes), [{ source: idOf(second, "/g/a.yaml"), path: "/x", outcome: "overrides", start: 3, end: 4, disk: bytes("5") }]);
  assert.deepEqual(second.index().map(e => [e.status, e.disk]), [["overrides", bytes("5")]]);
  assert.equal(await previewText(second, "/g/a.yaml"), "x: 7\ny: 2\n");
  second.close();
});

test("case 4: a colleague deleted the entry: the source is restored, then the edit is dropped as `conflicted` `gone`", async () => {
  const memory = createMemoryHost({ "/g/a.yaml": A });
  const first = await openOn(memory, "/g/a.yaml");
  await first.stage("/g/a.yaml", { op: "set", path: "/x", value: 7 });
  const saved = first.save();
  first.close();
  memory.write("/g/a.yaml", "y: 2\n");
  const second = await openOn(memory, "/g/a.yaml");
  const changes = heard(second);
  const report = await second.restore(saved);
  assert.deepEqual(report.sources.map(s => [s.outcome, s.edits.map(e => e.outcome)]), [["restored", ["restored"]]]);
  assert.deepEqual(notices(changes).map(n => [n.path, n.outcome, n.reason]), [["/x", "conflicted", "gone"]]);
  assert.deepEqual(second.index(), []);
  second.close();
});

test("case 5: saved as `overrides`: after a restore on an unchanged disk the edit is still `overrides`, with the same disk bytes, and a commit reports it overrode", async () => {
  const memory = createMemoryHost({ "/g/a.yaml": A });
  const first = await openOn(memory, "/g/a.yaml");
  await first.stage("/g/a.yaml", { op: "set", path: "/x", value: 7 });
  memory.write("/g/a.yaml", "x: 5\ny: 2\n");
  await absorbed(first, "/g/a.yaml");
  assert.deepEqual(first.index().map(e => e.status), ["overrides"]); // precondition
  const second = await openOn(memory, "/g/a.yaml");
  const changes = heard(second);
  await second.restore(first.save());
  assert.deepEqual(second.index(), first.index());
  assert.deepEqual(second.index().map(e => [e.status, e.disk]), [["overrides", bytes("5")]]);
  assert.deepEqual(notices(changes), []); // the disk is the base: no rebase ran
  const committed = await second.commit();
  assert.deepEqual(committed.sources[0]?.edits, [{ path: "/x", outcome: "overrode", disk: bytes("5") }]);
  assert.equal(await read(memory, "/g/a.yaml"), "x: 7\ny: 2\n");
  first.close();
  second.close();
});

const TWO = { "/g/a.yaml": A, "/g/b.yaml": "z: 1\n" }; // b's value at 3-4

async function twoSaved(memory: ReturnType<typeof createMemoryHost>) {
  const first = await openOn(memory, "/g/a.yaml", [yamlWriter()], ["/g/b.yaml"]);
  await first.stage("/g/a.yaml", { op: "set", path: "/x", value: 7 });
  await first.stage("/g/b.yaml", { op: "set", path: "/z", value: 2 });
  const saved = first.save();
  first.close();
  return saved;
}

test("case 6: saved bytes that do not hash to the base: that source is refused by name, the others are restored", async () => {
  const memory = createMemoryHost(TWO);
  const saved = await twoSaved(memory);
  const tampered = saved.sources[0];
  assert.ok(tampered);
  tampered.bytes[0] = 0x58; // `x: 1` becomes `X: 1`
  const second = await openOn(memory, "/g/a.yaml", [yamlWriter()], ["/g/b.yaml"]);
  const report = await second.restore(saved);
  assert.deepEqual(report, {
    outcome: "restored",
    sources: [
      { location: "/g/a.yaml", outcome: "refused", reason: "the saved bytes do not hash to the saved base version", edits: [] },
      { location: "/g/b.yaml", outcome: "restored", edits: [{ path: "/z", outcome: "restored" }] },
    ],
  });
  assert.deepEqual(second.index().map(e => e.path), ["/z"]);
  second.close();
});

test("case 7: a source that already has staged edits is refused by name, untouched, and the others are restored", async () => {
  const memory = createMemoryHost(TWO);
  const saved = await twoSaved(memory);
  const second = await openOn(memory, "/g/a.yaml", [yamlWriter()], ["/g/b.yaml"]);
  await second.stage("/g/a.yaml", { op: "set", path: "/y", value: 8 });
  const report = await second.restore(saved);
  assert.deepEqual(report.sources.map(s => [s.location, s.outcome, s.reason]), [
    ["/g/a.yaml", "refused", "/g/a.yaml already has staged edits"],
    ["/g/b.yaml", "restored", undefined],
  ]);
  assert.deepEqual(second.index().map(e => [e.path, e.value]), [["/y", 8], ["/z", 2]]); // a.yaml's own edit stays, alone
  second.close();
});

test("case 8: an unknown format is refused whole, and the index is untouched", async () => {
  const memory = createMemoryHost(TWO);
  const saved = await twoSaved(memory);
  const second = await openOn(memory, "/g/a.yaml", [yamlWriter()], ["/g/b.yaml"]);
  await second.stage("/g/a.yaml", { op: "set", path: "/y", value: 8 });
  const before = second.index();
  const report = await second.restore({ ...saved, format: 2 } as unknown as SavedIndex);
  assert.deepEqual(report, { outcome: "refused", reason: "the saved index has format 2, and only format 1 is known", sources: [] });
  assert.deepEqual(second.index(), before);
  second.close();
});

test("case 9: two inserts at one spot, saved and restored: the same order in index() and the same preview", async () => {
  const memory = createMemoryHost({ "/g/walls.yaml": WALLS });
  const first = await openOn(memory, "/g/walls.yaml");
  await first.stage("/g/walls.yaml", { op: "add", path: "/walls/W4", value: wall(3.4) });
  await first.stage("/g/walls.yaml", { op: "add", path: "/walls/W3", value: wall(3.2) });
  const second = await openOn(memory, "/g/walls.yaml");
  await second.restore(first.save());
  assert.deepEqual(second.index().map(e => [e.path, e.start, e.end]), [["/walls/W4", 51, 51], ["/walls/W3", 51, 51]]);
  assert.deepEqual(second.index(), first.index());
  assert.equal(await previewText(second, "/g/walls.yaml"), WALLS + W4 + W3);
  first.close();
  second.close();
});

test("case 10: a staged insert that was amended is one edit with the amended value, and restores as that", async () => {
  const memory = createMemoryHost({ "/g/walls.yaml": WALLS });
  const first = await openOn(memory, "/g/walls.yaml");
  await first.stage("/g/walls.yaml", { op: "add", path: "/walls/W3", value: wall(3.2) });
  await first.stage("/g/walls.yaml", { op: "set", path: "/walls/W3/height", value: 3.4 });
  const saved = first.save();
  assert.deepEqual(saved.sources[0]?.edits, [{ op: "add", path: "/walls/W3", value: wall(3.4), status: "staged" }]);
  const second = await openOn(memory, "/g/walls.yaml");
  await second.restore(saved);
  assert.deepEqual(second.index().map(e => [e.op, e.path, e.value]), [["add", "/walls/W3", wall(3.4)]]);
  assert.equal(await previewText(second, "/g/walls.yaml"), WALLS + "  W3:\n    height: 3.4\n");
  first.close();
  second.close();
});

test("case 12: a writer that throws during a restore: the call rejects, and the index is exactly as before, nothing announced", async () => {
  const memory = createMemoryHost({ "/a.conf": "a=1\n", "/b.conf": "c=1\n", "/c.conf": "e=1\n" });
  const first = await openOn(memory, "/a.conf", [keyValue], ["/b.conf", "/c.conf"]);
  await first.stage("/a.conf", { op: "set", path: "a", value: "7" });
  await first.stage("/b.conf", { op: "set", path: "c", value: "BOOM" });
  const saved = first.save();
  first.close();
  const second = await openOn(memory, "/a.conf", [bomb], ["/b.conf", "/c.conf"]);
  await second.stage("/c.conf", { op: "set", path: "e", value: "3" });
  const before = second.index();
  const changes = heard(second);
  await assert.rejects(second.restore(saved), /writer broke/);
  assert.deepEqual(second.index(), before); // a.conf was restored first, and is gone again
  assert.deepEqual(second.save().sources.map(s => s.location), ["/c.conf"]);
  assert.deepEqual(changes, []);
  assert.equal(await previewText(second, "/c.conf"), "e=3\n");
  second.close();
});

test("FR-006: a location that is not a source in the graph, and one no writer claims, are refused by name", async () => {
  const memory = createMemoryHost({ "/g/a.yaml": A });
  const saved: SavedIndex = {
    format: 1,
    sources: [
      { location: "/g/zzz.yaml", base: sha(A), bytes: bytes(A), edits: [{ op: "set", path: "/x", value: 7, status: "staged" }] },
      { location: "/g/a.yaml", base: sha(A), bytes: bytes(A), edits: [{ op: "set", path: "/x", value: 7, status: "staged" }] },
    ],
  };
  const unwritten = await openOn(memory, "/g/a.yaml", []);
  assert.deepEqual((await unwritten.restore(saved)).sources.map(s => [s.location, s.outcome, s.reason]), [
    ["/g/zzz.yaml", "refused", "not a source in the session's graph"],
    ["/g/a.yaml", "refused", "no writer claims /g/a.yaml"],
  ]);
  assert.deepEqual(unwritten.index(), []);
  unwritten.close();
});

test("FR-007: an edit the writer refuses on the saved base is reported with the writer's words, and the source's other edits are restored", async () => {
  const memory = createMemoryHost({ "/g/a.yaml": A });
  const writerSays = (() => {
    const opening = yamlWriter().open(bytes(A));
    assert.ok(opening.ok);
    const answer = opening.document.write("/nope", 1);
    assert.ok(!answer.ok);
    return answer.reason;
  })();
  const saved: SavedIndex = {
    format: 1,
    sources: [
      {
        location: "/g/a.yaml",
        base: sha(A),
        bytes: bytes(A),
        edits: [
          { op: "set", path: "/x", value: 7, status: "staged" },
          { op: "set", path: "/nope", value: 1, status: "staged" },
          { op: "set", path: "/y", status: "staged" }, // a set without a value: hand-made, not something save produces
        ],
      },
    ],
  };
  const session = await openOn(memory, "/g/a.yaml");
  assert.deepEqual(await session.restore(saved), {
    outcome: "restored",
    sources: [
      {
        location: "/g/a.yaml",
        outcome: "restored",
        edits: [
          { path: "/x", outcome: "restored" },
          { path: "/nope", outcome: "refused", reason: writerSays },
          { path: "/y", outcome: "refused", reason: "a set needs a value" },
        ],
      },
    ],
  });
  assert.deepEqual(session.index().map(e => e.path), ["/x"]);
  // A source none of whose edits can be restored is refused as a whole, and stages nothing.
  const none = await openOn(memory, "/g/a.yaml");
  const only = await none.restore({ format: 1, sources: [{ ...saved.sources[0]!, edits: [{ op: "set", path: "/nope", value: 1, status: "staged" }] }] });
  assert.deepEqual(only.sources.map(s => [s.outcome, s.reason]), [["refused", "none of its edits could be restored"]]);
  assert.deepEqual(none.index(), []);
  session.close();
  none.close();
});

test("FR-004: a waiting source restores waiting against its saved base, and rebases when a version that opens arrives", async () => {
  const picky: Writer = { claims: keyValue.claims, open: data => (data[0] === 0x21 ? { ok: false, reason: "not a conf file" } : keyValue.open(data)) };
  const memory = createMemoryHost({ "/w.conf": "a=1\nb=2\n" });
  const first = await openOn(memory, "/w.conf", [picky]);
  await first.stage("/w.conf", { op: "set", path: "a", value: "7" });
  const saved = first.save();
  first.close();
  memory.write("/w.conf", "!\na=1\nb=2\n"); // saved mid-typing while the page was closed
  const second = await openOn(memory, "/w.conf", [picky]);
  await second.restore(saved);
  assert.deepEqual(second.index().map(e => [e.waiting, e.base, e.start, e.end]), [["not a conf file", sha("a=1\nb=2\n"), 2, 3]]);
  memory.write("/w.conf", "# n\na=1\nb=2\n"); // "# n⏎" is 4 bytes: a's value at 6-7
  await absorbed(second, "/w.conf");
  assert.deepEqual(second.index().map(e => [e.waiting, e.start, e.end]), [[undefined, 6, 7]]);
  second.close();
});

test("FR-008: the notices of a rebase are announced after the restore is kept: a listener that throws rejects the call and undoes nothing", async () => {
  const memory = createMemoryHost({ "/g/a.yaml": A });
  const first = await openOn(memory, "/g/a.yaml");
  await first.stage("/g/a.yaml", { op: "set", path: "/x", value: 7 });
  const saved = first.save();
  first.close();
  memory.write("/g/a.yaml", "# c\n" + A);
  const second = await openOn(memory, "/g/a.yaml");
  second.onChange(() => {
    throw new Error("listener broke");
  });
  await assert.rejects(second.restore(saved), /listener broke/);
  assert.deepEqual(second.index().map(e => [e.start, e.end]), [[7, 8]]);
  second.close();
});
