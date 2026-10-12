import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { Edge, EditValue, Handler, Host, Session, Source, Writer, WriterDocument } from "../src/index.ts";

/** A test-only include handler: `@include{src="…"}` on its own line requires its target. */
export const include: Handler = {
  claims: location => location.endsWith(".md"),
  analyze(text) {
    const requests = [...text.matchAll(/^@include\{src="([^"]*)"\}$/gm)].map(match => {
      const start = match.index + match[0].indexOf('"') + 1;
      return { start, end: start + match[1].length, request: match[1], kind: "requires" as const };
    });
    return { requests };
  },
};

export const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export function byLocation(session: Session, location: string): Source {
  const source = session.sources().find(s => s.location === location);
  assert.ok(source, `no source at ${location}`);
  return source;
}

/** The bytes an edge's `from` address points at, decoded. */
export async function slice(host: Host, session: Session, edge: Edge): Promise<string> {
  const source = session.source(edge.from.source);
  assert.ok(source);
  const read = await host.read(source.location);
  assert.ok(read.ok);
  return new TextDecoder().decode(read.bytes.slice(edge.from.start, edge.from.end));
}

/**
 * Waits until the session has absorbed every host event delivered so far. Events arrive at the
 * next microtask; session work runs one piece at a time, so re-adding an existing root queues
 * behind them and changes nothing.
 */
export async function absorbed(session: Session, root: string): Promise<void> {
  await tick();
  await session.addRoot(root);
}

/** The one-shot shape every writer had before `open` (specs/insert-delete/ FR-001): bytes in, answer out, per call. */
export interface OneShotWriter {
  claims(location: string): boolean;
  locate(bytes: Uint8Array, path: string): ReturnType<WriterDocument["locate"]>;
  write(bytes: Uint8Array, path: string, value: EditValue): ReturnType<WriterDocument["write"]>;
}

/** A one-shot writer as a Writer: `open` keeps the bytes and every verb asks the one-shot again. */
export const opened = (shot: OneShotWriter): Writer => ({
  claims: shot.claims,
  open: bytes => ({ ok: true, document: { locate: path => shot.locate(bytes, path), write: (path, value) => shot.write(bytes, path, value) } }),
});

/**
 * A test-only writer for a `key=value` line format, claiming `.conf`: the path is the key, the
 * value is written as its string, and `locate` gives the range of the text after `=` on the line.
 */
export const keyValueShot: OneShotWriter = {
  claims: location => location.endsWith(".conf"),
  locate(bytes, path) {
    const text = new TextDecoder().decode(bytes);
    let offset = 0;
    for (const line of text.split("\n")) {
      const cut = line.indexOf("=");
      if (cut >= 0 && line.slice(0, cut) === path) {
        const start = offset + cut + 1;
        const encoded = (index: number) => new TextEncoder().encode(text.slice(0, index)).length;
        return { ok: true, start: encoded(start), end: encoded(offset + line.length) };
      }
      offset += line.length + 1;
    }
    return { ok: false, reason: `no key ${path}` };
  },
  write(bytes, path, value) {
    const found = keyValueShot.locate(bytes, path);
    return found.ok
      ? { ok: true, edit: { start: found.start, end: found.end, bytes: new TextEncoder().encode(String(value)) } }
      : found;
  },
};

export const keyValue: Writer = opened(keyValueShot);

/** Runs `action` and returns what escaped it as an unhandled rejection (the runner's own listener stands aside). */
export async function unhandled(action: () => Promise<void>): Promise<unknown[]> {
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

/**
 * A temporary directory (true spelling) that the test removes when it ends, however it ends. A
 * failing assertion must fail the test, not leave a directory behind.
 */
export async function scratch(t: TestContext, prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Closes a session when the test ends, however it ends. A session on the Node host holds watchers,
 * and an open one keeps the runner alive after a failing assertion: the run hangs instead of failing.
 */
export function closing<S extends { close(): void }>(t: TestContext, session: S): S {
  t.after(() => session.close());
  return session;
}
