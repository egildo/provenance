import { test } from "node:test";
import assert from "node:assert/strict";
import { openSession } from "../src/index.ts";
import type { Host } from "../src/index.ts";
import { createMemoryHost } from "../src/memory.ts";
import { css } from "../src/css.ts";
import { byLocation, include, slice } from "./helpers.ts";

test("an include chain: three sources, two edges, each pointing at the bytes that asked", async () => {
  const host = createMemoryHost({
    "/d/a.md": 'café ✓ 𝄞\n@include{src="b.md"}\n',
    "/d/b.md": '@include{src="sub/c.md"}\n',
    "/d/sub/c.md": "the end\n",
  });
  const session = await openSession({ host, entry: "/d/a.md", handlers: [include] });
  assert.deepEqual(session.sources().map(s => [s.location, s.state]), [
    ["/d/a.md", "analysed"],
    ["/d/b.md", "analysed"],
    ["/d/sub/c.md", "analysed"],
  ]);
  const edges = session.sources().flatMap(s => session.edgesFrom(s.id));
  assert.equal(edges.length, 2);
  for (const edge of edges) {
    assert.equal(edge.kind, "requires");
    assert.equal(edge.origin, "declared");
    assert.equal(await slice(host, session, edge), edge.request);
  }
  const b = byLocation(session, "/d/b.md");
  assert.equal(session.edgesInto(b.id).length, 1);
  assert.equal(session.edgesInto(b.id)[0].target, b.id);
  assert.match(b.state === "analysed" ? b.version : "", /^[0-9a-f]{64}$/);
});

test("a cycle is recorded and reported, and analysis ends", async () => {
  const host = createMemoryHost({
    "/a.md": '@include{src="b.md"}\n',
    "/b.md": '@include{src="a.md"}\n',
  });
  const session = await openSession({ host, entry: "/a.md", handlers: [include] });
  assert.equal(session.sources().length, 2);
  const cycles = session.cycles();
  assert.equal(cycles.length, 1);
  assert.deepEqual([...cycles[0]].sort(), session.sources().map(s => s.id).sort());
});

test("two spellings of one file are one source", async () => {
  const host = createMemoryHost({
    "/a.md": '@include{src="b.md"}\n@include{src="./x/../b.md"}\n',
    "/b.md": "",
  });
  const session = await openSession({ host, entry: "/a.md", handlers: [include] });
  assert.equal(session.sources().length, 2);
  const a = byLocation(session, "/a.md");
  assert.equal(session.edgesFrom(a.id).length, 2);
});

test("a source no handler claims is a leaf; invalid UTF-8 is undecodable", async () => {
  const host = createMemoryHost({
    "/a.md": '@include{src="pic.png"}\n@include{src="bad.md"}\n',
    "/pic.png": new Uint8Array([0x89, 0x50]),
    "/bad.md": new Uint8Array([0x40, 0xff, 0xfe]),
  });
  const session = await openSession({ host, entry: "/a.md", handlers: [include] });
  assert.equal(byLocation(session, "/pic.png").state, "leaf");
  const bad = byLocation(session, "/bad.md");
  assert.equal(bad.state, "undecodable");
  assert.equal(session.edgesFrom(bad.id).length, 0);
});

test("a missing entry is reported, not thrown", async () => {
  const host = createMemoryHost();
  const session = await openSession({ host, entry: "/missing.md", handlers: [include] });
  const entry = byLocation(session, "/missing.md");
  assert.equal(entry.state, "refused");
});

test("a refused read is a source carrying the host's reason", async () => {
  const host = createMemoryHost({ "/a.md": '@include{src="secret.md"}\n', "/secret.md": "" });
  host.refuse("/secret.md", "permission denied");
  const session = await openSession({ host, entry: "/a.md", handlers: [include] });
  const secret = byLocation(session, "/secret.md");
  assert.deepEqual(secret.state === "refused" && secret.reason, "permission denied");
});

test("roots the entry never asks for join the session, and leave with their dependencies", async () => {
  const host = createMemoryHost({
    "/a.md": "",
    "/style.css": "@font-face { src: url(serif.woff2) }",
    "/serif.woff2": new Uint8Array([0, 1, 0, 0]),
  });
  const session = await openSession({ host, entry: "/a.md", handlers: [include, css] });
  await session.addRoot("/style.css");
  assert.equal(byLocation(session, "/serif.woff2").state, "leaf");
  await session.removeRoot("/style.css");
  assert.deepEqual(session.sources().map(s => s.location), ["/a.md"]);
});

test("data makes no edge; the web is external and never read", async () => {
  let reads = 0;
  const memory = createMemoryHost({ "/a.css": "a { b: url(data:image/png;base64,AA); c: url(https://x/f.woff2) }" });
  const host: Host = { ...memory, read: location => (reads++, memory.read(location)) };
  const session = await openSession({ host, entry: "/a.css", handlers: [css] });
  const a = byLocation(session, "/a.css");
  const edges = session.edgesFrom(a.id);
  assert.equal(edges.length, 1);
  const web = session.source(edges[0].target ?? "");
  assert.deepEqual(web && [web.location, web.state], ["https://x/f.woff2", "external"]);
  assert.equal(reads, 1);
});

test("unresolved edges are listed with their probes", async () => {
  const host = createMemoryHost({ "/d/a.md": '@include{src="missing.md"}\n' });
  const session = await openSession({ host, entry: "/d/a.md", handlers: [include] });
  const [edge] = session.unresolved();
  assert.equal(edge.target, undefined);
  assert.deepEqual(edge.probes, ["/d/missing.md"]);
});
