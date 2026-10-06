import { test } from "node:test";
import assert from "node:assert/strict";
import { openSession } from "../src/index.ts";
import type { Handler, Host } from "../src/index.ts";
import { createMemoryHost } from "../src/memory.ts";
import { include, tick } from "./helpers.ts";

/** A test-only handler that throws on any text containing BOOM. */
const throwing: Handler = {
  claims: location => location.endsWith(".md"),
  analyze(text) {
    if (text.includes("BOOM")) throw new Error("handler broke");
    return include.analyze(text);
  },
};

/** Runs `action`, and returns what escaped as an unhandled rejection while it ran. */
async function unhandled(action: () => Promise<void>): Promise<unknown[]> {
  // The test runner has its own listener, which would fail this test; ours replaces it for the duration.
  const saved = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  const seen: unknown[] = [];
  process.on("unhandledRejection", reason => void seen.push(reason));
  try {
    await action();
    await new Promise(resolve => setTimeout(resolve, 20));
  } finally {
    process.removeAllListeners("unhandledRejection");
    for (const listener of saved) process.on("unhandledRejection", listener);
  }
  return seen;
}

const files = {
  "/a.md": "fine\n",
  "/top.md": '@include{src="bad.md"}\n',
  "/bad.md": "BOOM\n",
  "/ok.md": "healthy\n",
};

test("a rejected addRoot leaves the session as it was; the next call runs", async () => {
  const host = createMemoryHost(files);
  const session = await openSession({ host, entry: "/a.md", handlers: [throwing] });
  const before = session.sources();
  // top.md analyses fine and is loaded before bad.md throws: it must not stay.
  await assert.rejects(session.addRoot("/top.md"), /handler broke/);
  assert.deepEqual(session.sources(), before);
  await session.addRoot("/ok.md");
  assert.deepEqual(session.sources().map(s => s.location), ["/a.md", "/ok.md"]);
});

test("a read pass whose end() throws leaves its label's previous roots", async () => {
  const host = createMemoryHost(files);
  const session = await openSession({ host, entry: "/a.md", handlers: [throwing] });
  const first = session.read("render");
  first.note("/ok.md");
  await first.end();
  const before = session.sources();
  assert.deepEqual(before.map(s => s.location), ["/a.md", "/ok.md"]);

  const second = session.read("render");
  second.note("/top.md");
  await assert.rejects(second.end(), /handler broke/);
  assert.deepEqual(session.sources(), before);
  await session.addRoot("/a.md"); // runs normally, and does not drop /ok.md, still the label's root
  assert.deepEqual(session.sources(), before);
});

test("a throw from a host verb on an embedder's call also rejects it and rolls back", async () => {
  const memory = createMemoryHost(files);
  const host: Host = {
    ...memory,
    async read(location) {
      if (location === "/bad.md") throw new Error("host broke");
      return memory.read(location);
    },
  };
  const session = await openSession({ host, entry: "/a.md", handlers: [throwing] });
  const before = session.sources();
  await assert.rejects(session.addRoot("/top.md"), /host broke/);
  assert.deepEqual(session.sources(), before);
  await session.addRoot("/ok.md");
});

test("a handler that throws on a change the host reports escapes as an unhandled rejection", async () => {
  const host = createMemoryHost({ "/a.md": '@include{src="b.md"}\n', "/b.md": "one\n", "/ok.md": "healthy\n" });
  const session = await openSession({ host, entry: "/a.md", handlers: [throwing] });
  const before = session.sources();
  const seen = await unhandled(async () => {
    host.write("/b.md", "BOOM\n");
    await tick();
  });
  assert.equal(seen.length, 1);
  assert.match(String(seen[0]), /handler broke/);
  // Not shown as analysed at the version whose analysis threw: /b.md is still at the version it had.
  assert.deepEqual(session.sources(), before);
  await session.addRoot("/ok.md"); // the queue survived
  assert.equal(session.sources().length, before.length + 1);
});

test("a host verb that throws on a change the host reports escapes the same way", async () => {
  const memory = createMemoryHost({ "/a.md": '@include{src="b.md"}\n', "/b.md": "one\n", "/ok.md": "healthy\n" });
  let broken = false;
  const host: Host = {
    ...memory,
    async read(location) {
      if (broken && location === "/b.md") throw new Error("host broke");
      return memory.read(location);
    },
  };
  const session = await openSession({ host, entry: "/a.md", handlers: [throwing] });
  broken = true;
  const seen = await unhandled(async () => {
    memory.write("/b.md", "two\n");
    await tick();
  });
  assert.equal(seen.length, 1);
  assert.match(String(seen[0]), /host broke/);
  broken = false;
  await session.addRoot("/ok.md");
});
