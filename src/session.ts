// A session: roots, every source reachable from them, and the declared edges between them.
// Rules and states are specs/source-graph-kernel/data-model.md's.

import { byteOffsets } from "./offsets.ts";
import { hasScheme, resolve } from "./resolvers.ts";
import type {
  Change,
  Edge,
  EditNotice,
  CommitReport,
  Findings,
  Handler,
  Host,
  ReadPass,
  RenderManifest,
  Resolver,
  Preview,
  Session,
  SessionHost,
  Source,
  SourceCommit,
  StagedEdit,
  StageResult,
  Writer,
} from "./index.ts";

/** An edge as held inside the session: its target is a key (canonical location or URL), not an id. */
interface Link {
  readonly from: { readonly start: number; readonly end: number };
  readonly request: string;
  /** What is resolved: the request, or the root-absolute request it joins to under a rooted base. */
  readonly lookup: string;
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

/** `bytes` are kept for a source a writer claims, so an edit can be staged against, and rebased from, the version the session holds. */
type Node = State & { readonly id: string; readonly key: string; links: Link[]; readonly bytes?: Uint8Array };

/** One staged edit as held: the splice, and what finds it again. */
interface Staged {
  path: string;
  value: unknown;
  start: number;
  end: number;
  bytes: Uint8Array;
  status: "staged" | "overrides";
  disk?: Uint8Array;
}

/** The staged edits of one source, all against its base version. */
interface Staging {
  readonly writer: Writer;
  version: string;
  base: Uint8Array;
  edits: Staged[];
  /** The version of the last preview analysed, held while these edits stay as they are. */
  preview?: string;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  (a.start < b.end && b.start < a.end) || (a.start === a.end && b.start === b.end && a.start === b.start);

/** A writer's range outside the bytes it was given is its bug, like an index `byteOffsets` cannot convert. */
function checkRange(length: number, start: number, end: number, what: string) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > length) {
    throw new RangeError(`${what} gave the range ${start}-${end}, outside the ${length} bytes it was given`);
  }
}

/** The base with every edit spliced in, applied from the end backwards so each range stays valid. */
function splice(base: Uint8Array, edits: readonly Staged[]): Uint8Array {
  let out = base;
  for (const e of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    const next = new Uint8Array(e.start + e.bytes.length + (out.length - e.end));
    next.set(out.subarray(0, e.start));
    next.set(e.bytes, e.start);
    next.set(out.subarray(e.end), e.start + e.bytes.length);
    out = next;
  }
  return out;
}

/** Findings per handler and version, shared by every session that uses the handler. */
const cache = new WeakMap<Handler, Map<string, Findings>>();

/**
 * What every open session holds: the handler and version of each source it has analysed, and of
 * each finding its running piece of work has taken from the cache or made so far. A finding lives
 * while some open session holds it (specs/held-versions/); `sweep` drops the rest.
 */
const open = new Set<() => Iterable<readonly [Handler, string]>>();

/**
 * Drops from the cache of each given handler every version no open session holds. Safe at the end
 * of any session's piece of work: a session mid-work holds what its piece has met.
 * ponytail: walks every held source of every open session per sweep; keep a count per version if
 * a session of many thousands of sources ever makes that cost show.
 */
function sweep(handlers: readonly Handler[]) {
  const held = new Map<Handler, Set<string>>();
  for (const holds of open) {
    for (const [handler, version] of holds()) {
      const versions = held.get(handler) ?? new Set<string>();
      held.set(handler, versions.add(version));
    }
  }
  for (const handler of handlers) {
    const byVersion = cache.get(handler);
    if (byVersion) for (const version of byVersion.keys()) if (!held.get(handler)?.has(version)) byVersion.delete(version);
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  // `slice` copies onto a plain ArrayBuffer: digest refuses a view that may be shared memory.
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));
  return Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
}

/** A root-absolute URL path, such as `<base href="/">`'s: a path on the embedder's site, never a directory. */
const isRooted = (base: string) =>
  base.startsWith("/") && !base.startsWith("//");

/**
 * Joins a relative request to a rooted base the way a browser does, so it resolves as the
 * root-absolute request that results, which is the embedder's (research.md, Resolution). Any other
 * request stays as written.
 */
function joined(request: string, base: string | undefined): string {
  if (base === undefined || !isRooted(base) || request === "" || /^[#/]/.test(request) || hasScheme(request)) return request;
  const url = new URL(request, new URL(base, "http://site"));
  return url.pathname + url.search + url.hash;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export async function openSession(options: {
  host: Host;
  entry: string;
  handlers: readonly Handler[];
  resolvers?: readonly Resolver[];
  /** The editing half of the format plug-ins; the first that claims a location is its writer. */
  writers?: readonly Writer[];
  /** Locations under which a commit may write. Absent means nothing is writable. */
  writable?: readonly string[];
}): Promise<Session> {
  const { host, handlers, resolvers = [], writers = [], writable = [] } = options;
  if (typeof options.entry !== "string" || options.entry === "") throw new TypeError("entry must be a location");

  const ids = new Map<string, string>();
  const nodes = new Map<string, Node>();
  /** The entry and what the embedder added; no read pass touches these. */
  const roots = new Set<string>();
  /** What each label's latest ended read pass recorded. */
  const passRoots = new Map<string, ReadonlySet<string>>();
  /** The open pass per label, by identity, so a newer pass can discard an older one. */
  const livePasses = new Map<string, object>();
  const listeners = new Set<(change: Change) => void>();
  // No call started this work, so a throw has nowhere to go but out: re-rejecting makes it unhandled.
  const watch = host.watch(locations => void serialize(() => absorb(locations)).catch(error => Promise.reject(error)));
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  /** What the running piece of work has analysed or read from the cache; released when it ends. */
  const inFlight: (readonly [Handler, string])[] = [];
  /** The staged edits, by the source's key. A preview of them is a version like any other. */
  const staged = new Map<string, Staging>();
  function* holds() {
    yield* inFlight;
    for (const [key, staging] of staged) {
      const handler = staging.preview === undefined ? undefined : handlers.find(h => h.claims(key));
      if (handler && staging.preview !== undefined) yield [handler, staging.preview] as const;
    }
    for (const node of nodes.values()) {
      if (node.state !== "analysed") continue;
      const handler = handlers.find(h => h.claims(node.key));
      if (handler) yield [handler, node.version] as const;
    }
  }
  open.add(holds);

  /**
   * Runs session work one piece at a time, so a change batch never interleaves with another.
   * Work still queued at `close()` never runs. Work that throws leaves the session as it was, and
   * rejects the returned promise; the queue goes on. The change the work returns is announced only
   * after the work is kept, so a listener's throw rejects the call and undoes nothing.
   */
  function serialize(work: () => Promise<Change | void>): Promise<void> {
    const next = queue.then(async () => {
      if (closed) return;
      const before = {
        ids: new Map(ids),
        nodes: new Map(nodes),
        roots: new Set(roots),
        passRoots: new Map(passRoots),
        staged: new Map([...staged].map(([key, staging]) => [key, { ...staging, edits: staging.edits.map(e => ({ ...e })) }])),
        // Links are mutated in place when the world changes under them.
        links: [...nodes.values()].flatMap(node => node.links.map(l => ({ link: l, target: l.target, probes: l.probes }))),
      };
      let change: Change | void;
      notices.length = 0;
      writtenKeys.length = 0;
      try {
        change = await work();
      } catch (error) {
        for (const { link: l, target, probes } of before.links) {
          l.target = target;
          l.probes = probes;
        }
        restore(ids, before.ids);
        restore(nodes, before.nodes);
        restore(passRoots, before.passRoots);
        restore(staged, before.staged);
        notices.length = 0;
        for (const key of writtenKeys) staged.delete(key); // their edits are on disk; the host's change report brings the session up to them
        writtenKeys.length = 0;
        roots.clear();
        for (const key of before.roots) roots.add(key);
        throw error;
      } finally {
        // After a rollback has restored the nodes, so the versions it went back to are still held.
        inFlight.length = 0;
        sweep(handlers);
      }
      if (change) emit(change);
    });
    queue = next.catch(() => undefined);
    return next;
  }

  function restore<K, V>(live: Map<K, V>, saved: ReadonlyMap<K, V>) {
    live.clear();
    for (const [key, value] of saved) live.set(key, value);
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
    const found = await resolve(link.lookup, link.base, host, resolvers);
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
    if (base === undefined || isRooted(base)) return directory;
    if (base.startsWith("//")) return `https:${base}`;
    if (/^https?:/i.test(base)) return base;
    const resolved = host.paths.resolve(directory, base);
    return base.endsWith("/") ? resolved : host.paths.dirname(resolved);
  }

  /** The handler's findings for one version, from the cache or made now; held until the piece of work ends. */
  function findingsFor(handler: Handler, version: string, text: string): Findings {
    let byVersion = cache.get(handler);
    if (!byVersion) cache.set(handler, (byVersion = new Map()));
    let findings = byVersion.get(version);
    if (!findings) byVersion.set(version, (findings = handler.analyze(text)));
    inFlight.push([handler, version]);
    return findings;
  }

  /** What rebases did to staged edits during the running piece of work, for the change it reports. */
  const notices: EditNotice[] = [];
  /** Sources the running commit has written. A disk write cannot be rolled back, so they stay committed. */
  const writtenKeys: string[] = [];
  const drained = (): { edits?: readonly EditNotice[] } => {
    const edits = notices.splice(0);
    return edits.length === 0 ? {} : { edits };
  };

  /** Every staged edit of a source whose target is gone is conflicted: dropped, and reported. */
  function conflict(key: string) {
    const staging = staged.get(key);
    if (!staging) return;
    staged.delete(key);
    for (const e of staging.edits) notices.push({ source: idFor(key), path: e.path, outcome: "conflicted" });
  }

  /** Moves a source's staged edits onto `bytes`, its new version, finding each by its path (FR-008). */
  function rebase(key: string, staging: Staging, bytes: Uint8Array, version: string) {
    const source = idFor(key);
    const kept: Staged[] = [];
    for (const e of staging.edits) {
      const found = staging.writer.locate(bytes, e.path);
      if (!found.ok) {
        notices.push({ source, path: e.path, outcome: "conflicted" });
        continue;
      }
      checkRange(bytes.length, found.start, found.end, "the writer");
      // The value is written again on the new bytes: its spelling can depend on its neighbours.
      const again = staging.writer.write(bytes, e.path, e.value);
      if (!again.ok) {
        notices.push({ source, path: e.path, outcome: "conflicted" });
        continue;
      }
      const { start, end } = again.edit;
      checkRange(bytes.length, start, end, "the writer");
      const now = bytes.slice(start, end);
      const was = staging.base.subarray(e.start, e.end);
      const same = now.length === was.length && now.every((byte, i) => byte === was[i]);
      const moved = start !== e.start || end !== e.end;
      const status = same ? e.status : "overrides";
      const disk = same ? e.disk : now;
      kept.push({ path: e.path, value: e.value, bytes: again.edit.bytes, start, end, status, ...(disk === undefined ? {} : { disk }) });
      if (!same) notices.push({ source, path: e.path, outcome: "overrides", start, end, disk: now });
      else if (moved) notices.push({ source, path: e.path, outcome: "moved", start, end });
      else if (!sameBytes(again.edit.bytes, e.bytes)) notices.push({ source, path: e.path, outcome: "respelled", start, end });
    }
    staging.edits = kept;
    staging.base = bytes;
    staging.version = version;
    staging.preview = undefined;
    if (kept.length === 0) staged.delete(key);
  }

  /** Takes a source's new version into the session, rebasing the edits staged against the old one. */
  function adopt(key: string, fresh: Node) {
    nodes.set(key, fresh);
    const staging = staged.get(key);
    if (!staging) return;
    if (fresh.state === "refused" || fresh.state === "external" || fresh.bytes === undefined) conflict(key);
    else rebase(key, staging, fresh.bytes, fresh.version);
  }

  /** Reads, hashes and analyses one source. Never throws for the state of the world. */
  async function load(key: string, external: boolean): Promise<Node> {
    const id = idFor(key);
    if (external) return { id, key, state: "external", links: [] };
    const read = await host.read(key);
    if (!read.ok) return { id, key, state: "refused", reason: read.reason, links: [] };
    const version = await sha256(read.bytes);
    const handler = handlers.find(h => h.claims(key));
    const kept = writers.some(w => w.claims(key)) ? { bytes: read.bytes } : {};
    if (!handler) return { id, key, state: "leaf", version, links: [], ...kept };
    let text: string;
    try {
      text = decoder.decode(read.bytes);
    } catch {
      return { id, key, state: "undecodable", version, links: [], ...kept };
    }
    const findings = findingsFor(handler, version, text);

    const indices = findings.requests.flatMap(r => [r.start, r.end]);
    const offsets = byteOffsets(text, indices);
    const base = baseFor(key, findings.base);
    const links: Link[] = [];
    for (const [k, r] of findings.requests.entries()) {
      const l: Link = { from: { start: offsets[2 * k], end: offsets[2 * k + 1] }, request: r.request, lookup: joined(r.request, findings.base), kind: r.kind, base, probes: [] };
      if (await link(l)) links.push(l);
    }
    return { id, key, state: "analysed", version, links, ...kept };
  }

  /**
   * Brings the session to its fixpoint: every source reachable from the roots is present, every
   * other one is gone, and the host watches what matters. Returns the keys added and removed.
   */
  async function settle(): Promise<{ added: string[]; removed: string[] }> {
    const reachable = new Set<string>();
    const added: string[] = [];
    const all = new Set([...roots, ...[...passRoots.values()].flatMap(keys => [...keys])]);
    const worklist = [...all].map(key => ({ key, external: false }));
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
    for (const key of removed) {
      nodes.delete(key);
      conflict(key); // a source that left the graph has nowhere for its edits to land
    }
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

  /** Tells every listener, each even if another throws; the first throw is then rethrown. */
  function emit(change: Change) {
    if (change.added.length + change.removed.length + change.changed.length + (change.edits?.length ?? 0) === 0) return;
    const thrown: unknown[] = [];
    for (const listener of listeners) {
      try {
        listener(change);
      } catch (error) {
        thrown.push(error);
      }
    }
    if (thrown.length > 0) throw thrown[0];
  }

  /** Settles, for anything that changes the roots or the world; returns the change to announce. */
  async function report(changedKeys: readonly string[]): Promise<Change> {
    const { added, removed } = await settle();
    return {
      added: added.map(idFor),
      removed: removed.map(idFor),
      changed: changedKeys.filter(key => nodes.has(key)).map(idFor),
      ...drained(),
    };
  }

  const versionOf = (node: Node | undefined) =>
    node === undefined ? undefined : node.state === "refused" ? `refused:${node.reason}` : "version" in node ? node.version : "external";

  /** Absorbs one batch of host events (data-model.md, rules 3 and 4). */
  async function absorb(locations: readonly string[]): Promise<Change> {
    const touched = new Set(locations);
    const changed: string[] = [];
    for (const node of [...nodes.values()]) {
      if (touched.has(node.key) && node.state !== "external") {
        const fresh = await load(node.key, false);
        if (versionOf(fresh) !== versionOf(node)) {
          adopt(node.key, fresh);
          changed.push(node.key);
        }
      }
    }
    for (const node of nodes.values()) {
      for (const l of node.links) if (l.probes.some(p => touched.has(p))) await link(l);
    }
    return report(changed);
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

  /** Ends a pass that is still its label's live one: its keys become the label's roots (data-model.md, rule 5). */
  async function endPass(label: string, keys: ReadonlySet<string>, reads: ReadonlyMap<string, string>): Promise<Change> {
    passRoots.set(label, keys);
    const changed: string[] = [];
    for (const [key, version] of reads) {
      const node = nodes.get(key);
      if (!node || versionOf(node) === version) continue;
      const fresh = await load(key, false);
      if (versionOf(fresh) !== versionOf(node)) {
        adopt(key, fresh);
        changed.push(key);
      }
    }
    const { added, removed } = await settle();
    // The render used other bytes than the session now holds: a change, not a new source.
    const mismatched = [...reads].filter(([key, version]) => nodes.has(key) && versionOf(nodes.get(key)) !== version).map(([key]) => key);
    return {
      added: added.filter(key => !mismatched.includes(key)).map(idFor),
      removed: removed.map(idFor),
      changed: [...new Set([...changed, ...mismatched])].filter(key => nodes.has(key)).map(idFor),
      ...drained(),
    };
  }

  function read(label = ""): ReadPass {
    const token = {};
    livePasses.set(label, token);
    const reads = new Map<string, string>();
    const notes = new Set<string>();
    const missing = new Set<string>();
    const recording: Promise<void>[] = [];
    let manifest: Promise<RenderManifest> | undefined;
    const recordMissing = (location: string) => void recording.push(keyFor(location).then(key => void missing.add(key)));

    const passHost: SessionHost = {
      paths: host.paths,
      async canonicalize(location) {
        const found = await host.canonicalize(location);
        if (found === undefined && manifest === undefined) missing.add(host.paths.resolve(location));
        return found;
      },
      // Hands back the host's answer at once; hashing and canonicalizing are recorded on the side.
      async read(location) {
        const result = await host.read(location);
        if (manifest !== undefined) return result;
        if (!result.ok) recordMissing(location);
        else {
          const bytes = result.bytes;
          recording.push(Promise.all([keyFor(location), sha256(bytes)]).then(([key, version]) => void reads.set(key, version)));
        }
        return result;
      },
      cacheRead: async () => undefined,
      cacheWrite: async () => {
        throw new Error("no cache configured");
      },
    };

    async function finish(): Promise<RenderManifest> {
      await Promise.all(recording);
      for (const key of [...reads.keys(), ...notes]) missing.delete(key);
      const keys = new Set([...reads.keys(), ...notes, ...missing]);
      if (livePasses.get(label) === token) {
        livePasses.delete(label);
        await serialize(() => endPass(label, keys, reads));
      }
      const noted = [...notes].filter(key => !reads.has(key)).map(key => ({ key, node: nodes.get(key) }));
      const versioned = (node: Node | undefined) => (node && "version" in node ? node.version : undefined);
      return {
        read: [
          ...[...reads].map(([key, version]) => ({ source: idFor(key), version })),
          ...noted.flatMap(({ key, node }) => {
            const version = versioned(node);
            return version === undefined ? [] : [{ source: idFor(key), version }];
          }),
        ],
        missing: [...missing, ...noted.filter(({ node }) => versioned(node) === undefined).map(({ key }) => key)],
      };
    }

    return {
      host: passHost,
      note(location) {
        if (manifest === undefined) recording.push(keyFor(location).then(key => void notes.add(key)));
      },
      end: () => (manifest ??= finish()),
    };
  }

  async function stageEdit(location: string, path: string, value: unknown): Promise<StageResult> {
    const key = await keyFor(location);
    const node = nodes.get(key);
    if (!node) return { ok: false, reason: "not a source in the session's graph" };
    if (node.state === "external") return { ok: false, reason: `${key} is external, and cannot be edited` };
    if (node.state === "refused") return { ok: false, reason: `${key} could not be read: ${node.reason}` };
    const writer = writers.find(w => w.claims(key));
    if (!writer) return { ok: false, reason: `no writer claims ${key}` };
    let staging = staged.get(key);
    // The base the session holds: the bytes of the version it last took in. A disk that has moved
    // since is the rebase's business, when the host reports it.
    const base = staging?.base ?? ("bytes" in node ? node.bytes : undefined);
    if (!base) return { ok: false, reason: `${key} was not read` };
    const written = writer.write(base, path, value);
    if (!written.ok) return { ok: false, reason: written.reason };
    const { start, end, bytes } = written.edit;
    checkRange(base.length, start, end, "the writer");
    const clash = (staging?.edits ?? []).find(e => e.path !== path && overlaps(e, written.edit));
    if (clash) return { ok: false, reason: `the edit overlaps the staged edit at ${clash.path}` };
    if (!staging) staged.set(key, (staging = { writer, version: node.version, base, edits: [] }));
    const edit: Staged = { path, value, start, end, bytes, status: "staged" };
    const at = staging.edits.findIndex(e => e.path === path);
    if (at < 0) staging.edits.push(edit);
    else staging.edits[at] = edit;
    staging.preview = undefined;
    return { ok: true };
  }

  /** Whether a commit may write here: under a writable root, judged on whole segments of canonical locations. */
  async function isWritable(key: string): Promise<boolean> {
    const { separator, resolve } = host.paths;
    for (const root of writable) {
      const canonical = (await host.canonicalize(root)) ?? resolve(root);
      const prefix = canonical.endsWith(separator) ? canonical : canonical + separator;
      if (key === canonical || key.startsWith(prefix)) return true;
    }
    return false;
  }

  /** Commits one source's staged edits (FR-009). The edits leave the index only when written or dropped. */
  async function commitSource(key: string, staging: Staging, changed: string[]): Promise<SourceCommit> {
    const source = idFor(key);
    const nothing = (outcome: "refused" | "failed", reason: string): SourceCommit => ({ source, location: key, outcome, reason, edits: [] });
    if (!(await isWritable(key))) return nothing("refused", `${key} is outside every writable root`);
    if (host.write === undefined) return nothing("refused", "the host cannot write");
    const read = await host.read(key);
    if (!read.ok) return nothing("failed", read.reason);
    const first = notices.length;
    const version = await sha256(read.bytes);
    if (version !== staging.version) rebase(key, staging, read.bytes, version);
    const dropped = notices.slice(first).filter(n => n.outcome === "conflicted" && n.source === source);
    const edits: SourceCommit["edits"][number][] = dropped.map(n => ({ path: n.path, outcome: "conflicted" }));
    const remaining = staged.get(key);
    if (!remaining) return { source, location: key, outcome: "conflicted", edits };
    const bytes = splice(remaining.base, remaining.edits);
    const written = await host.write(key, bytes);
    if (!written.ok) return nothing("failed", written.reason);
    for (const e of remaining.edits) edits.push(e.status === "overrides" && e.disk ? { path: e.path, outcome: "overrode", disk: e.disk } : { path: e.path, outcome: "written" });
    staged.delete(key);
    writtenKeys.push(key);
    const fresh = await load(key, false);
    if (versionOf(fresh) !== versionOf(nodes.get(key))) changed.push(key);
    nodes.set(key, fresh);
    return { source, location: key, outcome: "written", version: await sha256(bytes), edits };
  }

  const session: Session = {
    read,
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
        return report([]);
      }),
    removeRoot: location =>
      serialize(async () => {
        roots.delete(await keyFor(location));
        return report([]);
      }),
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    stage(location, path, value) {
      let result: StageResult = { ok: false, reason: "the session is closed" };
      return serialize(async () => void (result = await stageEdit(location, path, value))).then(() => result);
    },
    index: () =>
      [...staged].flatMap(([key, staging]) =>
        staging.edits.map(
          (e): StagedEdit => ({
            source: idFor(key),
            path: e.path,
            value: e.value,
            base: staging.version,
            start: e.start,
            end: e.end,
            status: e.status,
            ...(e.disk === undefined ? {} : { disk: e.disk }),
          }),
        ),
      ),
    unstage: (location, path) =>
      serialize(async () => {
        const key = await keyFor(location);
        const staging = staged.get(key);
        if (!staging) return;
        if (path === undefined) staged.delete(key);
        else {
          staging.edits = staging.edits.filter(e => e.path !== path);
          staging.preview = undefined;
          if (staging.edits.length === 0) staged.delete(key);
        }
      }),
    preview(id) {
      let result: Preview | undefined;
      return serialize(async () => {
        const node = nodeById(id);
        const staging = node && staged.get(node.key);
        if (!node || !staging) return;
        const bytes = splice(staging.base, staging.edits);
        const version = await sha256(bytes);
        const handler = handlers.find(h => h.claims(node.key));
        let text: string | undefined;
        try {
          text = decoder.decode(bytes);
        } catch {
          text = undefined;
        }
        if (handler && text !== undefined) {
          findingsFor(handler, version, text);
          staging.preview = version;
        }
        result = { bytes, version };
      }).then(() => result);
    },
    commit() {
      let result: CommitReport = { sources: [] };
      return serialize(async () => {
        const changed: string[] = [];
        const sources: SourceCommit[] = [];
        for (const [key, staging] of [...staged]) sources.push(await commitSource(key, staging, changed));
        result = { sources };
        return report(changed);
      }).then(() => result);
    },
    close() {
      closed = true;
      watch.close();
      listeners.clear();
      open.delete(holds);
      sweep(handlers);
    },
  };

  try {
    await serialize(async () => {
      roots.add(await keyFor(options.entry));
      await settle();
    });
  } catch (error) {
    session.close(); // nobody can close a session that never opened, and it would hold its finds forever
    throw error;
  }
  return session;
}
