// The public surface of the core, exactly as specs/source-graph-kernel/contracts/public-api.md
// names it. Terms are the glossary's (docs/glossary.md).

export { openSession } from "./session.ts";

export interface Session {
  /** A view of the host for other readers, such as Cascata. A successful read adds a root. */
  readonly host: SessionHost;
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

export interface Host {
  read(location: string): Promise<HostReadResult>;
  /** The canonical identity of a location, or `undefined` when nothing is there. */
  canonicalize(location: string): Promise<string | undefined>;
  readonly paths: PathFacility;
  watch(onChange: (locations: readonly string[]) => void): {
    /** Replaces the whole watched set. */
    set(locations: readonly string[]): void;
    close(): void;
  };
}

/** Satisfies Cascata's `Host` by shape. */
export interface SessionHost {
  read(location: string): Promise<HostReadResult>;
  canonicalize(location: string): Promise<string | undefined>;
  cacheRead(key: string): Promise<Uint8Array | undefined>;
  cacheWrite(key: string, bytes: Uint8Array): Promise<void>;
  readonly paths: PathFacility;
}
