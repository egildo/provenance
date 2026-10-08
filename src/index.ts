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
  /**
   * Stages a set edit of the value at `path` in the source at `location` (specs/editing/spec.md).
   * A new edit at a path that already has one replaces it. Refusals resolve; a writer bug throws.
   */
  stage(location: string, path: string, value: EditValue): Promise<StageResult>;
  /** The staged edits, source by source, each against its source's base version. */
  index(): readonly StagedEdit[];
  /** Drops the staged edit at `path`, or every staged edit of the source. */
  unstage(location: string, path?: string): Promise<void>;
  /** The source's base with every staged edit spliced in, or `undefined` when none is staged. */
  preview(id: string): Promise<Preview | undefined>;
  /**
   * Writes every source with staged edits, one file at a time and each atomically, rebasing first
   * where the disk moved. Not atomic across files: the report says exactly what landed.
   */
  commit(): Promise<CommitReport>;
  close(): void;
}

export interface CommitReport {
  /** One entry per source that had staged edits, in the order they were first staged. */
  readonly sources: readonly SourceCommit[];
}

export interface SourceCommit {
  readonly source: string;
  readonly location: string;
  /**
   * `written`; `refused` (outside every writable root, or the host has no write verb); `failed`
   * (the host's reason; the edits are kept); `conflicted` (every edit's target was gone, so
   * nothing was written).
   */
  readonly outcome: "written" | "refused" | "failed" | "conflicted";
  readonly reason?: string;
  /** The version written. */
  readonly version?: string;
  /** What became of each edit that was written or dropped; empty when refused or failed. */
  readonly edits: readonly {
    readonly path: string;
    /** `overrode`: the value on disk had changed, and the edit replaced it. */
    readonly outcome: "written" | "overrode" | "conflicted";
    /** The bytes on disk that an overriding edit replaced. */
    readonly disk?: Uint8Array;
  }[];
}

/**
 * The value an edit sets: a scalar. The same union, under the same name, as Cascata's writers take
 * (`EditValue`), so a writer from either library fits the other by shape and not by method bivariance.
 */
export type EditValue = string | number | bigint | boolean | null;

export type StageResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** One staged edit: a byte address in its source's base version, and the semantic address that finds it again. */
export interface StagedEdit {
  readonly source: string;
  readonly path: string;
  readonly value: EditValue;
  /** The base version the byte address is against. */
  readonly base: string;
  readonly start: number;
  readonly end: number;
  /** `"overrides"`: a rebase found the value changed on disk, and this edit will replace it. */
  readonly status: "staged" | "overrides";
  /** The bytes of the value on disk that an overriding edit will replace. */
  readonly disk?: Uint8Array;
}

/** A source's base plus its staged edits, with the content hash that names it as a version. */
export interface Preview {
  readonly bytes: Uint8Array;
  readonly version: string;
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
  /** What a rebase did to staged edits because their source changed; absent when it did nothing. */
  readonly edits?: readonly EditNotice[];
}

/**
 * One staged edit that a rebase moved, found overriding a newer value, dropped as conflicted, or
 * respelled: it kept its range, but its writer now spells the value differently on the new bytes.
 */
export interface EditNotice {
  readonly source: string;
  readonly path: string;
  readonly outcome: "moved" | "overrides" | "conflicted" | "respelled";
  /** The edit's new byte range in the source's new version; absent when conflicted. */
  readonly start?: number;
  readonly end?: number;
  /** The bytes on disk that an overriding edit will replace. */
  readonly disk?: Uint8Array;
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
 * property); `value` is an `EditValue`. Offsets are bytes.
 */
export interface Writer {
  claims(location: string): boolean;
  /** Where the value at `path` is in `bytes`, or why it is not there. */
  locate(bytes: Uint8Array, path: string): { readonly ok: true; readonly start: number; readonly end: number } | { readonly ok: false; readonly reason: string };
  /** The one splice that sets the value at `path`, in the source's own style, or why it cannot. */
  write(bytes: Uint8Array, path: string, value: EditValue): { readonly ok: true; readonly edit: { readonly start: number; readonly end: number; readonly bytes: Uint8Array } } | { readonly ok: false; readonly reason: string };
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
