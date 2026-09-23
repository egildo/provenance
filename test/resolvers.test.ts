import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryHost } from "../src/memory.ts";
import { resolve } from "../src/resolvers.ts";
import type { Resolver } from "../src/index.ts";

const host = createMemoryHost({ "/d/b.md": "b", "/d/sub/c d.png": "", "/root/abs.css": "" });

test("a relative request probes one location and targets it when something is there", async () => {
  assert.deepEqual(await resolve("./b.md?v=1#top", "/d", host), { probes: ["/d/b.md"], target: "/d/b.md" });
  assert.deepEqual(await resolve("sub/c%20d.png", "/d", host), { probes: ["/d/sub/c d.png"], target: "/d/sub/c d.png" });
});

test("a missing target is unresolved, with its probe", async () => {
  assert.deepEqual(await resolve("missing.md", "/d", host), { probes: ["/d/missing.md"] });
});

test("web requests are external", async () => {
  assert.deepEqual(await resolve("https://x/y.css", "/d", host), { external: "https://x/y.css" });
  assert.deepEqual(await resolve("//x/y.css", "/d", host), { external: "https://x/y.css" });
  assert.deepEqual(await resolve("y.css", "https://x/sub/", host), { external: "https://x/sub/y.css" });
});

test("data, fragments and empty requests make no edge", async () => {
  assert.equal(await resolve("data:image/png;base64,AA", "/d", host), null);
  assert.equal(await resolve("#glow", "/d", host), null);
  assert.equal(await resolve("", "/d", host), null);
});

test("root-absolute and unknown schemes are the embedder's", async () => {
  assert.deepEqual(await resolve("/abs.css", "/d", host), { probes: [] });
  assert.deepEqual(await resolve("mailto:x", "/d", host), { probes: [] });
  const rooted: Resolver = {
    claims: request => request.startsWith("/"),
    resolve: async (request, _base, h) => {
      const location = h.paths.resolve("/root", `.${request}`);
      const target = await h.canonicalize(location);
      return target === undefined ? { probes: [location] } : { probes: [location], target };
    },
  };
  assert.deepEqual(await resolve("/abs.css", "/d", host, [rooted]), { probes: ["/root/abs.css"], target: "/root/abs.css" });
});

test("the base is whatever directory the caller passes", async () => {
  assert.deepEqual(await resolve("../b.md", "/d/sub", host), { probes: ["/d/b.md"], target: "/d/b.md" });
});
