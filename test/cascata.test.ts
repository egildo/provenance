import { test } from "node:test";
import assert from "node:assert/strict";
import { openSession } from "../src/index.ts";
import { createMemoryHost } from "../src/memory.ts";
import { byLocation, include } from "./helpers.ts";

// Cascata's host contract, copied from cascata/src/resolve/host.ts and src/paths.ts (v1.8.1).
// Cascata is not installed: `session.host` must satisfy it by shape alone.
type HostReadResult = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly reason: string };
interface PathFacility {
  readonly separator: string;
  readonly homeDirectory: string | undefined;
  dirname(path: string): string;
  isAbsolute(path: string): boolean;
  resolve(base: string, segment?: string): string;
}
interface CascataHost {
  read(location: string): Promise<HostReadResult>;
  canonicalize(location: string): Promise<string | undefined>;
  cacheRead(key: string): Promise<Uint8Array | undefined>;
  cacheWrite(key: string, bytes: Uint8Array): Promise<void>;
  locate?(reference: string): Promise<string | undefined>;
  readonly paths?: PathFacility;
}

test("files Cascata reads through the session's host become roots", async () => {
  const host = createMemoryHost({ "/doc/a.md": "text\n", "/doc/config.yaml": "theme: dark\n" });
  const session = await openSession({ host, entry: "/doc/a.md", handlers: [include] });
  const cascata: CascataHost = session.host;

  const location = await cascata.canonicalize("/doc/./config.yaml");
  assert.equal(location, "/doc/config.yaml");
  const read = await cascata.read("/doc/config.yaml");
  assert.equal(read.ok, true);
  assert.equal(byLocation(session, "/doc/config.yaml").state, "leaf");

  assert.equal((await cascata.read("/doc/missing.yaml")).ok, false);
  assert.equal(session.sources().length, 2);
});

test("the session's host has no cache, the way Cascata allows", async () => {
  const session = await openSession({ host: createMemoryHost({ "/a.md": "" }), entry: "/a.md", handlers: [] });
  const cascata: CascataHost = session.host;
  assert.equal(await cascata.cacheRead("key"), undefined);
  await assert.rejects(cascata.cacheWrite("key", new Uint8Array()), /no cache configured/);
});
