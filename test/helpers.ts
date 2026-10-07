import assert from "node:assert/strict";
import type { Edge, Handler, Host, Session, Source, Writer } from "../src/index.ts";

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

/**
 * A test-only writer for a `key=value` line format, claiming `.conf`: the path is the key, the
 * value is written as its string, and `locate` gives the range of the text after `=` on the line.
 */
export const keyValue: Writer = {
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
    const found = keyValue.locate(bytes, path);
    return found.ok
      ? { ok: true, edit: { start: found.start, end: found.end, bytes: new TextEncoder().encode(String(value)) } }
      : found;
  },
};
