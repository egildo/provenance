import { test } from "node:test";
import assert from "node:assert/strict";
import { openSession } from "../src/index.ts";
import type { Change, Host, Session, Writer } from "../src/index.ts";
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
