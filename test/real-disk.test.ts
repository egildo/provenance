import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { editTarget, load } from "@egildo/cascata";
import type { Node } from "@egildo/cascata";
import { yamlWriter } from "@egildo/cascata/writers";
import { openSession } from "../src/index.ts";
import type { Change, Host, Session } from "../src/index.ts";
import { createMemoryHost } from "../src/memory.ts";
import { createNodeHost } from "../src/node.ts";

// Edges the joining milestone left untested (specs/fixes-0.5/plan.md, fixes 3 and 4): the
// location Cascata answers on a path behind a symbolic link, a read pass racing a commit, and a
// writable root in the wrong letter case. Expected values are worked out by hand.

const fixture = (name: string) => readFileSync(new URL(`./fixtures/geometry/${name}`, import.meta.url), "utf8");
const PROJECT = fixture("project.yaml"); // 80 bytes, W1's height `3.2` at 54-57 (joining.test.ts counts them)
const SCHEMA = fixture("house.schema.yaml");
const WALLS = fixture("walls.yaml");
const NEW_PROJECT = PROJECT.replace("W1:\n    height: 3.2", "W1:\n    height: 3.4");
const bytes = (text: string) => new TextEncoder().encode(text);
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** The scalar Cascata read at `/walls/W1/height`. */
function w1Height(tree: Node): unknown {
  const walls = tree.type === "mapping" ? tree.entries.get("walls") : undefined;
  const w1 = walls?.type === "mapping" ? walls.entries.get("W1") : undefined;
  const height = w1?.type === "mapping" ? w1.entries.get("height") : undefined;
  assert.equal(height?.type, "scalar");
  return height?.type === "scalar" ? height.value : undefined;
}

async function writeCascade(dir: string, project = PROJECT) {
  await fs.writeFile(path.join(dir, "project.yaml"), project);
  await fs.writeFile(path.join(dir, "house.schema.yaml"), SCHEMA);
  await fs.writeFile(path.join(dir, "walls.yaml"), WALLS);
}

// 3a. editTarget, stage, commit, on a real disk behind a symbolic link ------------------------

/**
 * The loop of joining FR-004 on the Node host, with every path as the caller spelled it. The
 * caller's spelling reaches the session, the read pass, Cascata and `writable` unmodified.
 */
async function loopThrough(spelled: string, truePath: string) {
  const entry = path.join(spelled, "project.yaml");
  const session = await openSession({ host: createNodeHost({ debounce: 50 }), entry, handlers: [], writers: [yamlWriter()], writable: [spelled] });
  try {
    const pass = session.read("cascade");
    const loaded = await load(entry, { host: pass.host, sandboxRoot: spelled });
    await pass.end();
    assert.ok(loaded.ok, "the cascade must load from a path behind a symbolic link");
    const target = editTarget(loaded.configuration, "/walls/W1/height");
    assert.ok(target.ok);
    // Cascata answers the document's `origin.id`, which is the spelling it was loaded under, link and all
    // (found by this test; the claim is only that the answer names the file). `stage` canonicalizes it.
    assert.equal(await fs.realpath(target.location), path.join(truePath, "project.yaml"));
    assert.deepEqual(await session.stage(target.location, target.pointer, 3.4), { ok: true });
    assert.deepEqual(session.index().map(e => [e.start, e.end]), [[54, 57]]);
    // The session holds one source for the file, however it is spelled to it.
    assert.equal(session.sources().filter(s => s.location.endsWith("project.yaml")).length, 1);
    const report = await session.commit();
    assert.deepEqual(report.sources.map(s => [s.location, s.outcome]), [[path.join(truePath, "project.yaml"), "written"]]);
    assert.equal(await fs.readFile(path.join(truePath, "project.yaml"), "utf8"), NEW_PROJECT);
    assert.equal(await fs.readFile(path.join(truePath, "house.schema.yaml"), "utf8"), SCHEMA);
    // Cascata, loading again through the same spelling, reads the value that was set.
    const again = session.read("cascade");
    const reloaded = await load(entry, { host: again.host, sandboxRoot: spelled });
    await again.end();
    assert.ok(reloaded.ok);
    assert.equal(w1Height(reloaded.configuration.tree), 3.4);
  } finally {
    session.close();
  }
}

test("fix 3: editTarget, stage and commit on a directory made under os.tmpdir() as os.tmpdir() spells it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "provenance-link-"));
  try {
    await writeCascade(dir);
    // On macOS this is /var/folders/…, and /var is a symbolic link to /private/var.
    await loopThrough(dir, await fs.realpath(dir));
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test("fix 3: the same through a symbolic link made for the test, so the property holds on any platform", async () => {
  const real = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "provenance-real-")));
  const link = `${real}-link`;
  try {
    await writeCascade(real);
    await fs.symlink(real, link);
    await loopThrough(link, real);
  } finally {
    await fs.rm(link, { force: true });
    await fs.rm(real, { recursive: true });
  }
});

// 3b. A read pass racing a commit ---------------------------------------------------------------

/**
 * A memory host whose `write` can be held at one of two points: `before` (the disk still holds the
 * old bytes) or `after` (the disk holds the new bytes, and the host has not yet said so). It also
 * counts every read of the entry, so a test knows Cascata asked for it once.
 */
function holding(memory: ReturnType<typeof createMemoryHost>, hold: "before" | "after") {
  let arrived!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => (arrived = resolve));
  const gate = new Promise<void>(resolve => (release = resolve));
  const reads: string[] = [];
  const host: Host = {
    ...memory,
    async read(location) {
      reads.push(location);
      return memory.read(location);
    },
    async write(location, data) {
      if (hold === "before") {
        arrived();
        await gate;
      }
      const result = await memory.write(location, data);
      if (hold === "after") {
        arrived();
        await gate;
      }
      return result;
    },
  };
  return { host, reached, release, reads };
}

async function openProject(host: Host) {
  const session = await openSession({ host, entry: "/g/project.yaml", handlers: [], writers: [yamlWriter()], writable: ["/g"] });
  const changes: Change[] = [];
  session.onChange(c => changes.push(c));
  return { session, changes };
}

const idOf = (session: Session, location: string) => session.sources().find(s => s.location === location)?.id ?? "";
const versionOf = (session: Session, location: string) => {
  const source = session.sources().find(s => s.location === location);
  return source && "version" in source ? source.version : undefined;
};

for (const hold of ["before", "after"] as const) {
  test(`fix 3: a pass that reads while a commit is held ${hold} the disk write sees whole old or whole new bytes, and the session's version agrees`, async () => {
    const memory = createMemoryHost({ "/g/project.yaml": PROJECT, "/g/house.schema.yaml": SCHEMA, "/g/walls.yaml": WALLS });
    const { host, reached, release, reads } = holding(memory, hold);
    const { session, changes } = await openProject(host);
    assert.deepEqual(await session.stage("/g/project.yaml", "/walls/W1/height", 3.4), { ok: true });
    const committing = session.commit(); // held inside the host's write
    await reached;
    // Held `before`, the disk is the old file; held `after`, the new one. Cascata reads it through a pass now.
    const seen = hold === "before" ? PROJECT : NEW_PROJECT;
    const pass = session.read("cascade");
    reads.length = 0;
    const loaded = await load("/g/project.yaml", { host: pass.host, sandboxRoot: "/g" });
    assert.ok(loaded.ok);
    assert.equal(w1Height(loaded.configuration.tree), hold === "before" ? 3.2 : 3.4);
    assert.equal(reads.filter(r => r === "/g/project.yaml").length, 1, "one read, so the bytes Cascata parsed are the bytes the pass recorded");
    // The pass ends behind the commit: session work is one piece at a time.
    const ending = pass.end();
    release();
    const report = await committing;
    const manifest = await ending;
    assert.equal(report.sources[0]?.outcome, "written");
    // The manifest names the version of the bytes Cascata parsed, whichever they were...
    assert.equal(manifest.read.find(r => r.source === idOf(session, "/g/project.yaml"))?.version, sha(bytes(seen)));
    // ...and the session holds the committed version, which differs from it only when the pass saw the old file.
    assert.equal(versionOf(session, "/g/project.yaml"), sha(bytes(NEW_PROJECT)));
    // Held before, the render used bytes the session no longer holds: the pass's own end says so.
    const reported = changes.filter(c => c.changed.includes(idOf(session, "/g/project.yaml"))).length;
    assert.equal(reported, hold === "before" ? 2 : 1, "the commit's change, and for a stale render a second one from the pass");
    session.close();
  });
}

test("fix 3: a pass that read the old file before a commit, and ends after it, reports the mismatch", async () => {
  const memory = createMemoryHost({ "/g/project.yaml": PROJECT, "/g/house.schema.yaml": SCHEMA, "/g/walls.yaml": WALLS });
  const { session, changes } = await openProject(memory);
  const pass = session.read("cascade");
  const loaded = await load("/g/project.yaml", { host: pass.host, sandboxRoot: "/g" });
  assert.ok(loaded.ok);
  assert.equal(w1Height(loaded.configuration.tree), 3.2);
  await session.stage("/g/project.yaml", "/walls/W1/height", 3.4);
  await session.commit();
  const manifest = await pass.end();
  assert.equal(manifest.read.find(r => r.source === idOf(session, "/g/project.yaml"))?.version, sha(bytes(PROJECT)));
  assert.equal(versionOf(session, "/g/project.yaml"), sha(bytes(NEW_PROJECT)));
  assert.deepEqual(changes.at(-1)?.changed, [idOf(session, "/g/project.yaml")]);
  session.close();
});

test("fix 3, on a real disk: reads racing a commit see the whole old file or the whole new one, never a torn one", async () => {
  // About 1.5 MB, so a write that is not atomic would be seen half done by a reader.
  const padding = "# padding padding padding padding padding padding padding padding\n".repeat(24000);
  const old = PROJECT + padding;
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "provenance-race-")));
  const file = path.join(dir, "project.yaml");
  try {
    await writeCascade(dir, old);
    const session = await openSession({ host: createNodeHost({ debounce: 50 }), entry: file, handlers: [], writers: [yamlWriter()], writable: [dir] });
    try {
      let was = old;
      let seenOld = 0;
      let seenNew = 0;
      for (let round = 0; round < 6; round += 1) {
        const value = 3.4 + round / 10; // 3.4, 3.5, … : each a different file
        const now = was.replace(/height: [0-9.]+/, `height: ${value}`);
        assert.ok(await session.stage(file, "/walls/W1/height", value));
        const pass = session.read("race");
        let done = false;
        const committing = session.commit().finally(() => (done = true));
        let last: Uint8Array = new Uint8Array();
        while (!done) {
          const result = await pass.host.read(file);
          assert.ok(result.ok);
          const text = new TextDecoder().decode(result.bytes);
          assert.ok(text === was || text === now, `round ${round}: a read of ${result.bytes.length} bytes is neither the old file (${was.length}) nor the new (${now.length})`);
          if (text === was) seenOld += 1;
          else seenNew += 1;
          last = result.bytes;
        }
        const report = await committing;
        assert.equal(report.sources[0]?.outcome, "written");
        const manifest = await pass.end();
        const source = session.sources().find(s => s.location === file);
        assert.equal(source && "version" in source ? source.version : "", sha(bytes(now)));
        // What the pass last handed out is what its manifest names.
        assert.equal(manifest.read.find(r => r.source === source?.id)?.version, sha(last));
        was = now;
      }
      assert.ok(seenOld + seenNew > 0);
    } finally {
      session.close();
    }
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});
