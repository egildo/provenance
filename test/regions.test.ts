import { test } from "node:test";
import assert from "node:assert/strict";
import { yamlWriter } from "@egildo/cascata/writers";
import { openSession } from "../src/index.ts";
import type { Handler, Session } from "../src/index.ts";
import { createMemoryHost } from "../src/memory.ts";
import { absorbed, closing, keyValue } from "./helpers.ts";

// Regions for writing (issue 3): one file holding text in two languages, each edited through its own writer.
// The file is `.conf` key=value text with a YAML block between two `---` lines, as a Markdown file has its
// frontmatter. Every expected offset and byte string is worked out by hand.
//
//   ---⏎                     0-3, the open fence; the region starts at 4
//   title: Annual report⏎    4-24   (`Annual report` at 11-24)
//   client: Rossi⏎           25-38  (`Rossi` at 33-38)   the region ends at 39
//   ---⏎                     39-42
//   intro=old⏎               43-52  (`old` at 49-51)

const FILE = "---\ntitle: Annual report\nclient: Rossi\n---\nintro=old\n";

/** A stub handler: the text between the first `---` line and the next one is a YAML region named `frontmatter`. */
const stub = (opaque = false): Handler => ({
  claims: location => location.endsWith(".conf"),
  analyze: text => {
    const open = text.indexOf("---\n");
    const close = open < 0 ? -1 : text.indexOf("\n---\n", open + 3);
    return { requests: [], ...(close < 0 ? {} : { regions: [{ name: "frontmatter", start: open + 4, end: close + 1, language: "yaml", ...(opaque ? { opaque: true } : {}) }] }) };
  },
});

async function opened(file = FILE, handler = stub()) {
  const memory = createMemoryHost({ "/doc.conf": file });
  const session = await openSession({ host: memory, entry: "/doc.conf", handlers: [handler], writers: [keyValue], regionWriters: { yaml: yamlWriter() }, writable: ["/"] });
  return { memory, session };
}

const text = async (memory: ReturnType<typeof createMemoryHost>) => {
  const read = await memory.read("/doc.conf");
  assert.ok(read.ok);
  return new TextDecoder().decode(read.bytes);
};
const title = (session: Session, value: string) => session.stage("/doc.conf", { op: "set", region: "frontmatter", path: "/title", value });
const intro = (session: Session, value: string) => session.stage("/doc.conf", { op: "set", path: "intro", value });

test("steps 1 and 2: a frontmatter edit and a body edit land in one commit, the frontmatter's offsets shifted by the region's start", async t => {
  const { memory, session } = await opened();
  closing(t, session);
  assert.deepEqual(await title(session, "Annual report 2026"), { ok: true });
  assert.deepEqual(await intro(session, "new"), { ok: true });
  // The region's value sits at 7-20 inside it; the file's offsets are those plus the region's start, 4.
  assert.deepEqual(session.index().map(e => [e.region, e.path, e.start, e.end]), [["frontmatter", "/title", 11, 24], [undefined, "intro", 49, 52]]);
  const report = await session.commit();
  assert.equal(report.outcome, "committed");
  assert.deepEqual(report.sources[0]?.edits, [{ region: "frontmatter", path: "/title", outcome: "written" }, { path: "intro", outcome: "written" }]);
  assert.equal(await text(memory), "---\ntitle: Annual report 2026\nclient: Rossi\n---\nintro=new\n");
});

test("step 3: a colleague changes the body; the frontmatter edit rebases and still lands", async t => {
  const { memory, session } = await opened();
  closing(t, session);
  await title(session, "Annual report 2026");
  await memory.write("/doc.conf", FILE.replace("intro=old", "intro=old\nmore=1"));
  await absorbed(session, "/doc.conf");
  assert.deepEqual(session.index().map(e => [e.region, e.start, e.end]), [["frontmatter", 11, 24]]);
  assert.equal((await session.commit()).outcome, "committed");
  assert.equal(await text(memory), "---\ntitle: Annual report 2026\nclient: Rossi\n---\nintro=old\nmore=1\n");
});

test("step 4: a colleague adds a line above the edit in the frontmatter: it moves, and still lands", async t => {
  const { memory, session } = await opened();
  closing(t, session);
  await session.stage("/doc.conf", { op: "set", region: "frontmatter", path: "/client", value: "Bianchi" });
  const seen: string[] = [];
  session.onChange(c => void c.edits?.forEach(e => seen.push(`${e.region ?? ""}${e.path}:${e.outcome}`)));
  // `author: x⏎` (10 bytes) is added before `title`: `Rossi` moves from 33-38 to 43-48.
  await memory.write("/doc.conf", FILE.replace("title:", "author: x\ntitle:"));
  await absorbed(session, "/doc.conf");
  assert.deepEqual(seen, ["frontmatter/client:moved"]);
  assert.deepEqual(session.index().map(e => [e.start, e.end]), [[43, 48]]);
  assert.equal((await session.commit()).outcome, "committed");
  assert.equal(await text(memory), "---\nauthor: x\ntitle: Annual report\nclient: Bianchi\n---\nintro=old\n");
});

test("step 4: a colleague changes the very value: the edit overrides, as any rebase says", async t => {
  const { memory, session } = await opened();
  closing(t, session);
  await title(session, "Annual report 2026");
  const seen: string[] = [];
  session.onChange(c => void c.edits?.forEach(e => seen.push(`${e.region ?? ""}${e.path}:${e.outcome}`)));
  await memory.write("/doc.conf", FILE.replace("Annual report", "Annual Report"));
  await absorbed(session, "/doc.conf");
  assert.deepEqual(seen, ["frontmatter/title:overrides"]);
  assert.equal((await session.commit()).outcome, "committed");
  assert.equal(await text(memory), "---\ntitle: Annual report 2026\nclient: Rossi\n---\nintro=old\n");
});

test("step 5: save and restore round-trip both edits, and a save with no region edit is still format 1", async t => {
  const { session } = await opened();
  closing(t, session);
  await title(session, "Annual report 2026");
  await intro(session, "new");
  const saved = session.save();
  assert.equal(saved.format, 2);
  assert.deepEqual(saved.sources[0]?.edits.map(e => [e.region, e.path]), [["frontmatter", "/title"], [undefined, "intro"]]);
  const again = await opened();
  closing(t, again.session);
  const restored = await again.session.restore(saved);
  assert.equal(restored.outcome, "restored");
  assert.deepEqual(again.session.index().map(e => [e.region, e.path, e.start, e.end]), session.index().map(e => [e.region, e.path, e.start, e.end]));
  await session.unstage("/doc.conf", "/title", "frontmatter");
  assert.equal(session.save().format, 1);
});

test("a region that is gone in the new version conflicts its edit as gone", async t => {
  const { memory, session } = await opened();
  closing(t, session);
  await title(session, "Annual report 2026");
  const seen: string[] = [];
  session.onChange(c => void c.edits?.forEach(e => seen.push(`${e.region ?? ""}${e.path}:${e.outcome}:${e.reason}`)));
  await memory.write("/doc.conf", "intro=old\n");
  await absorbed(session, "/doc.conf");
  assert.deepEqual(seen, ["frontmatter/title:conflicted:gone"]);
  assert.deepEqual(session.index(), []);
});

test("an opaque region refuses staging and names itself; so do an unknown region and a language with no writer", async t => {
  const opaque = await opened(FILE, stub(true));
  closing(t, opaque.session);
  const result = await title(opaque.session, "x");
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /frontmatter.*opaque/);
  const { session } = await opened();
  closing(t, session);
  const unknown = await session.stage("/doc.conf", { op: "set", region: "style", path: "/a", value: 1 });
  assert.match(unknown.ok ? "" : unknown.reason, /no region named style/);
  const bare = await openSession({ host: createMemoryHost({ "/doc.conf": FILE }), entry: "/doc.conf", handlers: [stub()], writers: [keyValue], writable: ["/"] });
  closing(t, bare);
  const none = await bare.stage("/doc.conf", { op: "set", region: "frontmatter", path: "/title", value: "x" });
  assert.match(none.ok ? "" : none.reason, /no writer.*yaml/);
});

test("two edits in one region and a body edit overlapping none of them all land; an edit with no region still goes through the enclosing writer", async t => {
  const { memory, session } = await opened();
  closing(t, session);
  await title(session, "T");
  await session.stage("/doc.conf", { op: "set", region: "frontmatter", path: "/client", value: "C" });
  assert.equal((await session.commit()).outcome, "committed");
  assert.equal(await text(memory), "---\ntitle: T\nclient: C\n---\nintro=old\n");
});

test("step 4: a colleague adds a line above the whole frontmatter: the region is found again, and the edit moves with it", async t => {
  const { memory, session } = await opened();
  closing(t, session);
  await title(session, "Annual report 2026");
  // `pre=1⏎` (6 bytes) comes first: the region starts at 10, and the value at 17-30.
  await memory.write("/doc.conf", `pre=1\n${FILE}`);
  await absorbed(session, "/doc.conf");
  assert.deepEqual(session.index().map(e => [e.start, e.end]), [[17, 30]]);
  assert.equal((await session.commit()).outcome, "committed");
  assert.equal(await text(memory), "pre=1\n---\ntitle: Annual report 2026\nclient: Rossi\n---\nintro=old\n");
});

test("a region that vanishes never sends its joined path to the enclosing writer", async t => {
  const seen: string[] = [];
  const spy = {
    ...keyValue,
    open: (bytes: Uint8Array) => {
      const opening = keyValue.open(bytes);
      if (!opening.ok) return opening;
      const doc = opening.document;
      return { ok: true as const, document: { ...doc, locate: (p: string) => (seen.push(p), doc.locate(p)), write: (p: string, v: never) => (seen.push(p), doc.write(p, v)) } };
    },
  };
  const memory = createMemoryHost({ "/doc.conf": FILE });
  const session = await openSession({ host: memory, entry: "/doc.conf", handlers: [stub()], writers: [spy], regionWriters: { yaml: yamlWriter() }, writable: ["/"] });
  closing(t, session);
  await title(session, "x");
  await memory.write("/doc.conf", "intro=old\n");
  await absorbed(session, "/doc.conf");
  assert.deepEqual(session.index(), []);
  assert.deepEqual(seen.filter(p => p.includes("\u0000")), []);
});

test("regions that are not sound are not used: bad range, overlap, duplicate name", async t => {
  const regions = (list: object[]): Handler => ({ claims: l => l.endsWith(".conf"), analyze: () => ({ requests: [], regions: list as never }) });
  const base = { name: "frontmatter", start: 4, end: 39, language: "yaml" };
  const cases: Record<string, object[]> = {
    "end before start": [{ ...base, start: 20, end: 10 }],
    "past the text": [{ ...base, end: 9999 }],
    "negative start": [{ ...base, start: -1 }],
    "not an integer": [{ ...base, start: 4.5 }],
    overlapping: [base, { ...base, name: "other", start: 30, end: 45 }],
    "same name twice": [base, { ...base, start: 43, end: 52 }],
  };
  for (const [label, list] of Object.entries(cases)) {
    const { session } = await opened(FILE, regions(list));
    closing(t, session);
    const result = await title(session, "x");
    assert.equal(result.ok, false, label);
    assert.deepEqual(await intro(session, "new"), { ok: true }, label);
  }
});

test("a NUL in a path or a region name is refused, not read as a region", async t => {
  const { session } = await opened();
  closing(t, session);
  const inPath = await session.stage("/doc.conf", { op: "set", path: "\u0000frontmatter\u0000/title", value: "x" });
  assert.equal(inPath.ok, false);
  const inRegion = await session.stage("/doc.conf", { op: "set", region: "front\u0000matter", path: "/title", value: "x" });
  assert.equal(inRegion.ok, false);
  assert.deepEqual(session.index(), []);
});

test("a region edit can remove a key, and an edit in the body is never inside one in the frontmatter", async t => {
  const { memory, session } = await opened();
  closing(t, session);
  assert.deepEqual(await session.stage("/doc.conf", { op: "remove", region: "frontmatter", path: "/client" }), { ok: true });
  // Same path text, other language: no containment across the region's border.
  assert.deepEqual(await session.stage("/doc.conf", { op: "set", path: "intro", value: "new" }), { ok: true });
  assert.equal((await session.commit()).outcome, "committed");
  assert.equal(await text(memory), "---\ntitle: Annual report\n---\nintro=new\n");
});

test("adding to a key that exists is refused by the region's writer and stages nothing", async t => {
  const { session } = await opened();
  closing(t, session);
  const added = await session.stage("/doc.conf", { op: "add", region: "frontmatter", path: "/title", value: "x" });
  assert.equal(added.ok, false);
  assert.deepEqual(session.index(), []);
});
