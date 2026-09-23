import { test } from "node:test";
import assert from "node:assert/strict";
import { openSession } from "../src/index.ts";
import type { Change, Findings, Handler } from "../src/index.ts";
import { createMemoryHost } from "../src/memory.ts";
import { absorbed, byLocation, include } from "./helpers.ts";

test("a broken include is visible while broken, and heals when its file appears", async () => {
  let calls = 0;
  const counted: Handler = { claims: include.claims, analyze: (text): Findings => (calls++, include.analyze(text)) };
  const host = createMemoryHost({ "/d/a.md": '@include{src="missing.md"}\n' });
  const session = await openSession({ host, entry: "/d/a.md", handlers: [counted] });

  const [broken] = session.unresolved();
  assert.deepEqual(broken.probes, ["/d/missing.md"]);
  assert.equal(calls, 1);

  const changes: Change[] = [];
  session.onChange(change => changes.push(change));
  host.write("/d/missing.md", "found\n");
  await absorbed(session, "/d/a.md");

  assert.deepEqual(session.unresolved(), []);
  const healed = byLocation(session, "/d/missing.md");
  assert.equal(healed.state, "analysed");
  assert.equal(session.edgesFrom(byLocation(session, "/d/a.md").id)[0].target, healed.id);
  assert.deepEqual(changes, [{ added: [healed.id], removed: [], changed: [] }]);
  assert.equal(calls, 2);
  session.close();
});

test("a missing entry heals when it is created", async () => {
  const host = createMemoryHost();
  const session = await openSession({ host, entry: "/a.md", handlers: [include] });
  host.write("/a.md", "hello\n");
  await absorbed(session, "/a.md");
  assert.equal(byLocation(session, "/a.md").state, "analysed");
  session.close();
});
