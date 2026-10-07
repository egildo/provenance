import { test } from "node:test";
import assert from "node:assert/strict";
import { openSession } from "../src/index.ts";
import type { Findings, Handler, Host } from "../src/index.ts";
import { createMemoryHost } from "../src/memory.ts";
import { absorbed, include, tick } from "./helpers.ts";

// Findings live while an open session holds their version (specs/held-versions/). The cache is
// private, so every case counts a fresh handler's calls; the expected counts are worked out by
// hand from FR-001 to FR-005, case by case.

/** As `counting()` in change.test.ts: a fresh include handler that counts its calls. */
function counting(): Handler & { calls: number } {
  const handler = {
    calls: 0,
    claims: include.claims,
    analyze(text: string): Findings {
      handler.calls++;
      return include.analyze(text);
    },
  };
  return handler;
}

test("case 1: sessions share a finding while one holds it, even after the first closes", async () => {
  const handler = counting();
  const host = createMemoryHost({ "/a.md": "one\n" });
  const a = await openSession({ host, entry: "/a.md", handlers: [handler] });
  const b = await openSession({ host, entry: "/a.md", handlers: [handler] });
  assert.equal(handler.calls, 1);
  a.close();
  const c = await openSession({ host, entry: "/a.md", handlers: [handler] });
  assert.equal(handler.calls, 1);
  b.close();
  c.close();
});

test("case 2: when every session has closed nothing holds the finding, and a new session analyses again", async () => {
  const handler = counting();
  const host = createMemoryHost({ "/a.md": "one\n" });
  const first = await openSession({ host, entry: "/a.md", handlers: [handler] });
  first.close();
  const second = await openSession({ host, entry: "/a.md", handlers: [handler] });
  assert.equal(handler.calls, 2);
  second.close();
});

test("case 3: a watching session forgets the version it left", async () => {
  const handler = counting();
  const host = createMemoryHost({ "/a.md": "one\n" });
  const session = await openSession({ host, entry: "/a.md", handlers: [handler] });
  host.write("/a.md", "two\n");
  await absorbed(session, "/a.md");
  host.write("/a.md", "one\n");
  await absorbed(session, "/a.md");
  assert.equal(handler.calls, 3); // v1, v2, v1 again
  session.close();
});

test("case 4: a version another session holds survives the first session leaving it", async () => {
  const handler = counting();
  const host = createMemoryHost({ "/a.md": "one\n" });
  const other = createMemoryHost({ "/a.md": "one\n" });
  const watcher = await openSession({ host, entry: "/a.md", handlers: [handler] });
  const holder = await openSession({ host: other, entry: "/a.md", handlers: [handler] });
  assert.equal(handler.calls, 1);
  host.write("/a.md", "two\n");
  await absorbed(watcher, "/a.md");
  host.write("/a.md", "one\n");
  await absorbed(watcher, "/a.md");
  assert.equal(handler.calls, 2); // v1, v2; v1 came back from the holder's finding
  watcher.close();
  holder.close();
});

test("case 5: twins share a finding, and one twin changing leaves it held by the other", async () => {
  const handler = counting();
  const host = createMemoryHost({
    "/a.md": '@include{src="b.md"}\n@include{src="c.md"}\n',
    "/b.md": "x\n",
    "/c.md": "x\n",
  });
  const session = await openSession({ host, entry: "/a.md", handlers: [handler] });
  assert.equal(handler.calls, 2); // a.md, and x once for both twins
  host.write("/b.md", "y\n");
  await absorbed(session, "/a.md");
  assert.equal(handler.calls, 3); // y
  host.write("/b.md", "x\n");
  await absorbed(session, "/a.md");
  assert.equal(handler.calls, 3); // c.md still held x
  session.close();
});

test("case 7: within one batch, a version two sources reach is analysed once", async () => {
  const handler = counting();
  const host = createMemoryHost({
    "/a.md": '@include{src="b.md"}\n@include{src="c.md"}\n',
    "/b.md": "x\n",
    "/c.md": "x\n",
  });
  const session = await openSession({ host, entry: "/a.md", handlers: [handler] });
  host.write("/b.md", "y\n");
  host.write("/c.md", "y\n");
  await absorbed(session, "/a.md");
  assert.equal(handler.calls, 3); // a.md, x, then y once
  session.close();
});

test("case 7, across sessions: another session ending its work does not drop a finding mid-work", async () => {
  const handler = counting();
  const memory = createMemoryHost({ "/a.md": "k\n", "/p.md": '@include{src="q.md"}\n', "/q.md": '@include{src="q.md"}\n' });
  let gate: Promise<void> | undefined;
  const host: Host = {
    ...memory,
    async canonicalize(location) {
      if (location === "/q.md") await gate;
      return memory.canonicalize(location);
    },
  };
  const bystander = createMemoryHost({ "/s.md": "z\n", "/t.md": "w\n" });
  const one = await openSession({ host, entry: "/a.md", handlers: [handler] });
  const two = await openSession({ host: bystander, entry: "/s.md", handlers: [handler] });
  assert.equal(handler.calls, 2); // a.md; s.md

  let release!: () => void;
  gate = new Promise<void>(resolve => (release = resolve));
  // p.md and q.md are twins. p.md is analysed, then its link waits on the gate: its finding is
  // cached, and no session holds it yet.
  const adding = one.addRoot("/p.md");
  while (handler.calls < 3) await tick();
  await tick();
  await two.addRoot("/t.md"); // the other session's piece of work ends here, and sweeps if it may
  assert.equal(handler.calls, 4); // w
  release();
  await adding;
  assert.equal(handler.calls, 4); // q.md, p.md's twin, found the finding still cached
  one.close();
  two.close();
});
