// The public surface of the core, exactly as specs/source-graph-kernel/contracts/public-api.md
// names it. Terms are the glossary's (docs/glossary.md).

export { openSession } from "./session.ts";

export interface Session {
  /** Starts a read pass (specs/read-passes/spec.md). Discards an open pass with the same label. */
  read(label?: string): ReadPass;
  sources(): readonly Source[];
  source(id: string): Source | undefined;
  edgesFrom(id: string): readonly Edge[];
  edgesInto(id: string): readonly Edge[];
  unresolved(): readonly Edge[];
  cycles(): readonly (readonly string[])[];
  addRoot(location: string): Promise<void>;
  removeRoot(location: string): Promise<void>;
  onChange(listener: (change: Change) => void): () => void;
  close(): void;
}

/** One render's reads through the session. */
export interface ReadPass {
  /** Cascata's `Host` shape. No member uses `this`, so it may be spread into a composed host. */
  readonly host: SessionHost;
  /** Records a location read outside `host.read`, such as a code module. */
  note(location: string): void;
  /** Makes the pass's locations its label's roots, replacing the previous pass's, and settles once. */
  end(): Promise<RenderManifest>;
}

/** Which version of each source a render used, and where it found nothing. */
export interface RenderManifest {
  readonly read: readonly { readonly source: string; readonly version: string }[];
  /** Locations. A note with nothing readable there is listed here. */
  readonly missing: readonly string[];
}

export type Source = {
  readonly id: string;
  readonly location: string;
} & (
  | { readonly state: "analysed" | "leaf" | "undecodable"; readonly version: string }
  | { readonly state: "refused"; readonly reason: string }
  | { readonly state: "external" }
);

/** A place in a source at a known version. Offsets are bytes; both absent means the whole source. */
export interface Address {
  readonly source: string;
  readonly version: string;
  readonly start?: number;
  readonly end?: number;
}

export interface Edge {
  readonly from: Address;
  readonly request: string;
  readonly target?: string;
  readonly kind: "requires" | "candidate";
  readonly origin: "declared";
  readonly probes: readonly string[];
}

export interface Change {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export interface Handler {
  claims(location: string): boolean;
  /** Pure. Throwing is a bug and propagates. */
  analyze(text: string): Findings;
}

export interface Findings {
  readonly requests: readonly {
    /** String index, inclusive. */
    readonly start: number;
    /** String index, exclusive. */
    readonly end: number;
    readonly request: string;
    readonly kind: "requires" | "candidate";
  }[];
  readonly base?: string;
}

export type Resolution =
  | { readonly probes: readonly string[]; readonly target?: string }
  | { readonly external: string }
  | null;

/**
 * The editing half of a format plug-in (specs/editing/spec.md). Pure, like a handler: it reads and
 * writes nothing. `path` is the format's own address of a value (a JSON Pointer, a selector and a
 * property); `value` is opaque to Provenance. Offsets are bytes.
 */
export interface Writer {
  claims(location: string): boolean;
  /** Where the value at `path` is in `bytes`, or why it is not there. */
  locate(bytes: Uint8Array, path: string): { readonly ok: true; readonly start: number; readonly end: number } | { readonly ok: false; readonly reason: string };
  /** The one splice that sets the value at `path`, in the source's own style, or why it cannot. */
  write(bytes: Uint8Array, path: string, value: unknown): { readonly ok: true; readonly edit: { readonly start: number; readonly end: number; readonly bytes: Uint8Array } } | { readonly ok: false; readonly reason: string };
}

export interface Resolver {
  claims(request: string): boolean;
  resolve(request: string, base: string, host: Host): Promise<Resolution>;
}

export type HostReadResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: string };

/** Cascata's shape. */
export interface PathFacility {
  readonly separator: string;
  readonly homeDirectory: string | undefined;
  dirname(path: string): string;
  isAbsolute(path: string): boolean;
  resolve(base: string, segment?: string): string;
}

export type HostWriteResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface Host {
  read(location: string): Promise<HostReadResult>;
  /** Optional: a host without it can stage and preview, and a commit is refused. Atomic per file. */
  write?(location: string, bytes: Uint8Array): Promise<HostWriteResult>;
  /** The canonical identity of a location, or `undefined` when nothing is there. */
  canonicalize(location: string): Promise<string | undefined>;
  readonly paths: PathFacility;
  watch(onChange: (locations: readonly string[]) => void): {
    /** Replaces the whole watched set. */
    set(locations: readonly string[]): void;
    close(): void;
  };
}

/** A read pass's view of the host. Satisfies Cascata's `Host` by shape. */
export interface SessionHost {
  read(location: string): Promise<HostReadResult>;
  canonicalize(location: string): Promise<string | undefined>;
  cacheRead(key: string): Promise<Uint8Array | undefined>;
  cacheWrite(key: string, bytes: Uint8Array): Promise<void>;
  readonly paths: PathFacility;
}
