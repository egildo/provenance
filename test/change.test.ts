import { test } from "node:test";
import assert from "node:assert/strict";
import { openSession } from "../src/index.ts";
import type { Change, Findings, Handler, Host, Session } from "../src/index.ts";
import { createMemoryHost } from "../src/memory.ts";
import { absorbed, byLocation, include } from "./helpers.ts";

/** A fresh include handler that counts its calls; fresh, so no other test's cache entries apply. */
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

function record(session: Session): Change[] {
  const changes: Change[] = [];
  session.onChange(change => changes.push(change));
  return changes;
}

test("a change reports once and costs one analysis", async () => {
  const handler = counting();
  const host = createMemoryHost({ "/a.md": '@include{src="b.md"}\n', "/b.md": "one\n" });
  const session = await openSession({ host, entry: "/a.md", handlers: [handler] });
  const changes = record(session);
  const b = byLocation(session, "/b.md");
  const calls = handler.calls;

  host.write("/b.md", "two\n");
  await absorbed(session, "/a.md");

  assert.deepEqual(changes, [{ added: [], removed: [], changed: [b.id] }]);
  assert.equal(handler.calls, calls + 1);
  assert.notDeepEqual(byLocation(session, "/b.md"), b);
  session.close();
});

test("rewriting identical bytes reports nothing and costs nothing", async () => {
  const handler = counting();
  const host = createMemoryHost({ "/a.md": "same\n" });
  const session = await openSession({ host, entry: "/a.md", handlers: [handler] });
  const changes = record(session);

  host.write("/a.md", "same\n");
  await absorbed(session, "/a.md");

  assert.deepEqual(changes, []);
  assert.equal(handler.calls, 1);
  session.close();
});

test("a source no longer reachable leaves, and is no longer watched", async () => {
  const memory = createMemoryHost({
    "/a.md": '@include{src="b.md"}\n',
    "/b.md": '@include{src="c.md"}\n',
    "/c.md": "c\n",
  });
  let watched: readonly string[] = [];
  const host: Host = {
    ...memory,
    watch(onChange) {
      const inner = memory.watch(onChange);
      return { set: locations => ((watched = locations), inner.set(locations)), close: inner.close };
    },
  };
  const session = await openSession({ host, entry: "/a.md", handlers: [include] });
  const changes = record(session);
  const c = byLocation(session, "/c.md");
  assert.ok(watched.includes("/c.md"));

  memory.write("/b.md", "no more includes\n");
  await absorbed(session, "/a.md");
  assert.deepEqual(changes, [{ added: [], removed: [c.id], changed: [byLocation(session, "/b.md").id] }]);
  assert.deepEqual([...watched].sort(), ["/a.md", "/b.md"]);
  session.close();
});

test("identical files share one analysis, and both still heal", async () => {
  const handler = counting();
  const twin = '@include{src="missing.md"}\n';
  const host = createMemoryHost({
    "/a.md": '@include{src="x/twin.md"}\n@include{src="y/twin.md"}\n',
    "/x/twin.md": twin,
    "/y/twin.md": twin,
  });
  const session = await openSession({ host, entry: "/a.md", handlers: [handler] });
  assert.equal(handler.calls, 2);
  assert.equal(session.unresolved().length, 2);

  host.write("/x/missing.md", "x\n");
  host.write("/y/missing.md", "y\n");
  await absorbed(session, "/a.md");
  assert.deepEqual(session.unresolved(), []);
  session.close();
});

test("one change in a session of 200 sources costs one analysis", async () => {
  const handler = counting();
  const files: Record<string, string> = {};
  for (let k = 0; k < 200; k++) files[`/s${k}.md`] = k < 199 ? `@include{src="s${k + 1}.md"}\n${k}\n` : "last\n";
  const host = createMemoryHost(files);
  const session = await openSession({ host, entry: "/s0.md", handlers: [handler] });
  assert.equal(session.sources().length, 200);
  const calls = handler.calls;

  host.write("/s100.md", '@include{src="s101.md"}\nedited\n');
  await absorbed(session, "/s0.md");
  assert.equal(handler.calls, calls + 1);
  session.close();
});

test("close is final: work running or queued at close never watches again", async () => {
  const memory = createMemoryHost({ "/a.md": "a\n", "/b.md": "b\n", "/c.md": "c\n" });
  let release = () => {};
  const gate = new Promise<void>(resolve => (release = resolve));
  let setsAfterClose = 0;
  let closed = false;
  const host: Host = {
    ...memory,
    async read(location) {
      if (location === "/b.md") await gate;
      return memory.read(location);
    },
    watch(onChange) {
      const inner = memory.watch(onChange);
      return { set: locations => (closed && setsAfterClose++, inner.set(locations)), close: inner.close };
    },
  };
  const session = await openSession({ host, entry: "/a.md", handlers: [include] });
  const running = session.addRoot("/b.md");
  const queued = session.addRoot("/c.md");
  await new Promise(resolve => setTimeout(resolve, 0));
  session.close();
  closed = true;
  release();
  await Promise.all([running, queued]);

  assert.equal(setsAfterClose, 0);
  assert.equal(session.sources().some(s => s.location === "/c.md"), false);
});
