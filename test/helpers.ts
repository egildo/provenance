import assert from "node:assert/strict";
import type { Edge, Handler, Host, Session, Source } from "../src/index.ts";

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
