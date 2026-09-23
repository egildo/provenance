// A session: roots, every source reachable from them, and the declared edges between them.
// Rules and states are specs/source-graph-kernel/data-model.md's.

import { byteOffsets } from "./offsets.ts";
import { resolve } from "./resolvers.ts";
import type {
  Change,
  Edge,
  Findings,
  Handler,
  Host,
  Resolver,
  Session,
  SessionHost,
  Source,
} from "./index.ts";

/** An edge as held inside the session: its target is a key (canonical location or URL), not an id. */
interface Link {
  readonly from: { readonly start: number; readonly end: number };
  readonly request: string;
  readonly kind: "requires" | "candidate";
  /** The directory (or URL) the request resolves against. */
  readonly base: string;
  target?: { key: string; external: boolean };
  probes: readonly string[];
}

type State =
  | { state: "analysed" | "leaf" | "undecodable"; version: string }
  | { state: "refused"; reason: string }
  | { state: "external" };

type Node = State & { readonly id: string; readonly key: string; links: Link[] };

/** Findings per handler and version, shared by every session that uses the handler. */
const cache = new WeakMap<Handler, Map<string, Findings>>();

async function sha256(bytes: Uint8Array): Promise<string> {
  // `slice` copies onto a plain ArrayBuffer: digest refuses a view that may be shared memory.
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));
  return Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export async function openSession(options: {
  host: Host;
  entry: string;
  handlers: readonly Handler[];
  resolvers?: readonly Resolver[];
}): Promise<Session> {
  const { host, handlers, resolvers = [] } = options;
  if (typeof options.entry !== "string" || options.entry === "") throw new TypeError("entry must be a location");

  const ids = new Map<string, string>();
  const nodes = new Map<string, Node>();
  const roots = new Set<string>();
  const listeners = new Set<(change: Change) => void>();
  const watch = host.watch(locations => void serialize(() => absorb(locations)));
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;

  /**
   * Runs session work one piece at a time, so a change batch never interleaves with another.
   * Work still queued at `close()` never runs.
   */
  function serialize(work: () => Promise<void>): Promise<void> {
    const next = queue.then(() => (closed ? undefined : work()));
    queue = next.catch(() => undefined);
    return next;
  }

  const idFor = (key: string) => {
    let id = ids.get(key);
    if (id === undefined) ids.set(key, (id = `s${ids.size + 1}`));
    return id;
  };

  const keyFor = async (location: string) =>
    (await host.canonicalize(location)) ?? host.paths.resolve(location);

  /** Resolves a link in place. False means the request makes no edge at all (`data:`, a fragment). */
  async function link(link: Link): Promise<boolean> {
    const found = await resolve(link.request, link.base, host, resolvers);
    if (found === null) return false;
    if ("external" in found) {
      link.target = { key: found.external, external: true };
      link.probes = [];
    } else {
      link.target = found.target === undefined ? undefined : { key: found.target, external: false };
      link.probes = found.probes;
    }
    return true;
  }

  function baseFor(key: string, base: string | undefined): string {
    const directory = host.paths.dirname(key);
    if (base === undefined) return directory;
    if (/^https?:/i.test(base)) return base;
    const resolved = host.paths.resolve(directory, base);
    return base.endsWith("/") ? resolved : host.paths.dirname(resolved);
  }

  /** Reads, hashes and analyses one source. Never throws for the state of the world. */
  async function load(key: string, external: boolean): Promise<Node> {
    const id = idFor(key);
    if (external) return { id, key, state: "external", links: [] };
    const read = await host.read(key);
    if (!read.ok) return { id, key, state: "refused", reason: read.reason, links: [] };
    const version = await sha256(read.bytes);
    const handler = handlers.find(h => h.claims(key));
    if (!handler) return { id, key, state: "leaf", version, links: [] };
    let text: string;
    try {
      text = decoder.decode(read.bytes);
    } catch {
      return { id, key, state: "undecodable", version, links: [] };
    }
    let byVersion = cache.get(handler);
    if (!byVersion) cache.set(handler, (byVersion = new Map()));
    let findings = byVersion.get(version);
    if (!findings) byVersion.set(version, (findings = handler.analyze(text)));

    const indices = findings.requests.flatMap(r => [r.start, r.end]);
    const offsets = byteOffsets(text, indices);
    const base = baseFor(key, findings.base);
    const links: Link[] = [];
    for (const [k, r] of findings.requests.entries()) {
      const l: Link = { from: { start: offsets[2 * k], end: offsets[2 * k + 1] }, request: r.request, kind: r.kind, base, probes: [] };
      if (await link(l)) links.push(l);
    }
    return { id, key, state: "analysed", version, links };
  }

  /**
   * Brings the session to its fixpoint: every source reachable from the roots is present, every
   * other one is gone, and the host watches what matters. Returns the keys added and removed.
   */
  async function settle(): Promise<{ added: string[]; removed: string[] }> {
    const reachable = new Set<string>();
    const added: string[] = [];
    const worklist = [...roots].map(key => ({ key, external: false }));
    for (let next = worklist.shift(); next; next = worklist.shift()) {
      if (reachable.has(next.key)) continue;
      reachable.add(next.key);
      let node = nodes.get(next.key);
      if (!node) {
        node = await load(next.key, next.external);
        nodes.set(next.key, node);
        added.push(next.key);
      }
      for (const l of node.links) if (l.target) worklist.push(l.target);
    }
    const removed = [...nodes.keys()].filter(key => !reachable.has(key));
    for (const key of removed) nodes.delete(key);
    const watched = new Set<string>();
    for (const node of nodes.values()) {
      if (node.state !== "external") watched.add(node.key);
      for (const l of node.links) for (const probe of l.probes) watched.add(probe);
    }
    // Work already running at `close()` finishes, but must not watch again: a Node host would
    // open directory watchers that keep the process alive.
    if (!closed) watch.set([...watched]);
    return { added, removed };
  }

  function emit(change: Change) {
    if (change.added.length + change.removed.length + change.changed.length === 0) return;
    for (const listener of listeners) listener(change);
  }

  /** Settles and reports, for anything that changes the roots or the world. */
  async function report(changedKeys: readonly string[]): Promise<void> {
    const { added, removed } = await settle();
    emit({
      added: added.map(idFor),
      removed: removed.map(idFor),
      changed: changedKeys.filter(key => nodes.has(key)).map(idFor),
    });
  }

  const versionOf = (node: Node | undefined) =>
    node === undefined ? undefined : node.state === "refused" ? `refused:${node.reason}` : "version" in node ? node.version : "external";

  /** Absorbs one batch of host events (data-model.md, rules 3 and 4). */
  async function absorb(locations: readonly string[]): Promise<void> {
    const touched = new Set(locations);
    const changed: string[] = [];
    for (const node of [...nodes.values()]) {
      if (touched.has(node.key) && node.state !== "external") {
        const fresh = await load(node.key, false);
        if (versionOf(fresh) !== versionOf(node)) {
          nodes.set(node.key, fresh);
          changed.push(node.key);
        }
      }
    }
    for (const node of nodes.values()) {
      for (const l of node.links) if (l.probes.some(p => touched.has(p))) await link(l);
    }
    await report(changed);
  }

  const edge = (node: Node, l: Link): Edge => {
    const target = l.target && nodes.get(l.target.key)?.id;
    const version = "version" in node ? node.version : "";
    return {
      from: { source: node.id, version, start: l.from.start, end: l.from.end },
      request: l.request,
      ...(target === undefined ? {} : { target }),
      kind: l.kind,
      origin: "declared",
      probes: l.probes,
    };
  };

  const view = (node: Node): Source => {
    const { id, key: location } = node;
    switch (node.state) {
      case "refused":
        return { id, location, state: node.state, reason: node.reason };
      case "external":
        return { id, location, state: node.state };
      default:
        return { id, location, state: node.state, version: node.version };
    }
  };

  const allEdges = () => [...nodes.values()].flatMap(node => node.links.map(l => edge(node, l)));
  const nodeById = (id: string) => [...nodes.values()].find(node => node.id === id);

  /** Strongly connected components with more than one source, or a source asking for itself (Tarjan). */
  function cycles(): string[][] {
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const found: string[][] = [];
    const next = (key: string) =>
      (nodes.get(key)?.links ?? []).flatMap(l => (l.target && nodes.has(l.target.key) ? [l.target.key] : []));
    const visit = (key: string) => {
      index.set(key, index.size);
      low.set(key, index.get(key) ?? 0);
      stack.push(key);
      for (const to of next(key)) {
        if (!index.has(to)) {
          visit(to);
          low.set(key, Math.min(low.get(key) ?? 0, low.get(to) ?? 0));
        } else if (stack.includes(to)) {
          low.set(key, Math.min(low.get(key) ?? 0, index.get(to) ?? 0));
        }
      }
      if (low.get(key) === index.get(key)) {
        const component: string[] = [];
        let member: string | undefined;
        do {
          member = stack.pop();
          if (member !== undefined) component.push(member);
        } while (member !== undefined && member !== key);
        if (component.length > 1 || next(key).includes(key)) found.push(component.map(idFor));
      }
    };
    for (const key of nodes.keys()) if (!index.has(key)) visit(key);
    return found;
  }

  const sessionHost: SessionHost = {
    paths: host.paths,
    canonicalize: location => host.canonicalize(location),
    async read(location) {
      const result = await host.read(location);
      if (result.ok) {
        const key = await keyFor(location);
        if (!roots.has(key)) await session.addRoot(key);
      }
      return result;
    },
    cacheRead: async () => undefined,
    cacheWrite: async () => {
      throw new Error("no cache configured");
    },
  };

  const session: Session = {
    host: sessionHost,
    sources: () => [...nodes.values()].map(view),
    source: id => {
      const node = nodeById(id);
      return node && view(node);
    },
    edgesFrom: id => allEdges().filter(e => e.from.source === id),
    edgesInto: id => allEdges().filter(e => e.target === id),
    unresolved: () => allEdges().filter(e => e.target === undefined),
    cycles,
    addRoot: location =>
      serialize(async () => {
        roots.add(await keyFor(location));
        await report([]);
      }),
    removeRoot: location =>
      serialize(async () => {
        roots.delete(await keyFor(location));
        await report([]);
      }),
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    close() {
      closed = true;
      watch.close();
      listeners.clear();
    },
  };

  await serialize(async () => {
    roots.add(await keyFor(options.entry));
    await settle();
  });
  return session;
}
