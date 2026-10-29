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
   * Stages an edit of the source at `location` (specs/editing/spec.md, specs/insert-delete/spec.md): the
   * operation's path in the format's own terms, and what to do there. A new edit at a path that already
   * has one replaces it. Refusals resolve; a writer bug throws.
   */
  stage(location: string, operation: EditOperation): Promise<StageResult>;
  /** The staged edits, source by source, each against its source's base version. */
  index(): readonly StagedEdit[];
  /** Drops the staged edit at `path`, or every staged edit of the source. */
  unstage(location: string, path?: string): Promise<void>;
  /**
   * The index as plain data (specs/saveable-index/spec.md): per staged source its location, base version and base
   * bytes, and each edit's operation, path, value and status, in staging order. It survives a structured clone.
   * Writing it anywhere is the embedder's.
   */
  save(): SavedIndex;
  /**
   * Stages a saved index again (specs/saveable-index/spec.md): per source, its edits are staged against the saved base
   * bytes through the writer, in saved order, and then rebased onto the version the session holds. A source that
   * already has staged edits, or whose bytes do not hash to the saved base, is refused and the others restored.
   */
  restore(saved: SavedIndex): Promise<RestoreReport>;
  /** The source's base with every staged edit spliced in, or `undefined` when none is staged. */
  preview(id: string): Promise<Preview | undefined>;
  /**
   * Writes every source with staged edits, or none: each is checked and rebased first, and one that cannot
   * be written (or an edit dropped on rebase) aborts the commit; a write that fails puts back the files
   * already written. Each file is written atomically by the host. The report says exactly what landed.
   */
  commit(): Promise<CommitReport>;
  close(): void;
}

export interface CommitReport {
  /** `committed`: every source landed (an empty index is committed). `aborted`: nothing did, bar any `unrestored` source. */
  readonly outcome: "committed" | "aborted";
  /** One entry per source that had staged edits, in the order they were first staged. */
  readonly sources: readonly SourceCommit[];
}

export interface SourceCommit {
  readonly source: string;
  readonly location: string;
  /**
   * `written`; `refused` (outside every writable root, the host has no write verb, or the disk version does not
   * open); `failed` (the host's reason; the edits are kept); `conflicted` (at least one edit was dropped on
   * rebase, and `edits` lists the dropped ones); `aborted` (this source was fine, but another one stopped the
   * commit, and `reason` names it; nothing of this source is on disk and its edits stay staged); `unrestored`
   * (this commit wrote it and could not put it back; `reason` says why, its edits are on disk and left the index).
   */
  readonly outcome: "written" | "refused" | "failed" | "conflicted" | "aborted" | "unrestored";
  readonly reason?: string;
  /** The version this commit wrote (also for `unrestored`). */
  readonly version?: string;
  /** What became of each edit that was written or dropped; empty when refused or failed. */
  readonly edits: readonly {
    readonly path: string;
    /** `overrode`: the value on disk had changed, and the edit replaced it. */
    readonly outcome: "written" | "overrode" | "conflicted";
    /** Why an edit was dropped; present exactly when `outcome` is `conflicted`. */
    readonly reason?: ConflictReason;
    /** The writer's words, as `EditNotice.detail` carries them (FIX-004). */
    readonly detail?: string;
    /** The bytes on disk that an overriding edit replaced. */
    readonly disk?: Uint8Array;
  }[];
}

/**
 * The value an edit sets: a scalar, a sequence or a mapping (a `Map` of string keys), nested. The same union,
 * under the same name, as Cascata's writers take (`EditData`), so a writer from either library fits the other
 * by shape and not by method bivariance. A plain object is not one: its array-index keys reorder and
 * `__proto__` is swallowed, so a writer refuses it as a programmer error.
 */
export type EditData = string | number | bigint | boolean | null | readonly EditData[] | ReadonlyMap<string, EditData>;

/**
 * Why a staged edit was dropped as conflicted: `gone`, its path is no longer found in the source's
 * new version (or the source left the graph); `overlap`, its new range overlaps an earlier-staged
 * edit's; `unwritable`, its writer found the path but refused to write the value on the new bytes; `exists`
 * (an insert), the key was added on disk meanwhile; `changed` (a delete), the entry was changed on disk meanwhile; `shifted`, a list
 * along its path changed length, so an index in it may name another item.
 */
export type ConflictReason = "gone" | "overlap" | "unwritable" | "exists" | "changed" | "shifted";

/** What `stage` is asked to do, JSON Patch's operation object with Cascata's verb names. */
export type EditOperation =
  | { readonly op: "set" | "add"; readonly path: string; readonly value: EditData }
  | { readonly op: "remove"; readonly path: string };

export type StageResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** One staged edit: a byte address in its source's base version, and the semantic address that finds it again. */
export interface StagedEdit {
  readonly source: string;
  readonly path: string;
  /** What the edit does at `path`. */
  readonly op: EditOperation["op"];
  /** The value as staged (a `Map` stays a `Map`); present for `set` and `add`, absent for `remove`. */
  readonly value?: EditData;
  /** The base version the byte address is against. */
  readonly base: string;
  readonly start: number;
  readonly end: number;
  /** `"overrides"`: a rebase found the value changed on disk, and this edit will replace it. */
  readonly status: "staged" | "overrides";
  /** The bytes of the value on disk that an overriding edit will replace. */
  readonly disk?: Uint8Array;
  /** Present while the source's newest version does not open: the writer's words. The edit waits against its base (FIX-001). */
  readonly waiting?: string;
}

/** What `session.save()` returns: the index as plain data, `Uint8Array` and `Map` the only objects in it. */
export interface SavedIndex {
  /** Which shape this is; `restore` refuses a number it does not know. */
  readonly format: 1;
  readonly sources: readonly {
    /** The canonical location the session staged under. */
    readonly location: string;
    /** The base version the edits were staged against, and the bytes that hash to it. */
    readonly base: string;
    readonly bytes: Uint8Array;
    readonly edits: readonly SavedEdit[];
  }[];
}

/** One saved edit: the semantic half only. Byte ranges are made again by the writer on restore. */
export interface SavedEdit {
  readonly op: EditOperation["op"];
  readonly path: string;
  readonly value?: EditData;
  readonly status: "staged" | "overrides";
  readonly disk?: Uint8Array;
}

export interface RestoreReport {
  /** `refused`: the whole save, for a `format` this version does not know (`reason` says so, and `sources` is empty). */
  readonly outcome: "restored" | "refused";
  readonly reason?: string;
  /** One entry per saved source, in the save's order. */
  readonly sources: readonly SourceRestore[];
}

export interface SourceRestore {
  readonly location: string;
  /**
   * `refused`: the source is not in the session's graph, no writer claims it, it already has staged edits, its saved
   * bytes do not hash to its base, or none of its edits could be staged; `reason` says which. Otherwise `restored`:
   * what the rebase onto the session's version then did arrives as the usual `Change` notices.
   */
  readonly outcome: "restored" | "refused";
  readonly reason?: string;
  /** Per saved edit, in saved order; empty when the source was refused before its edits were tried. */
  readonly edits: readonly {
    readonly path: string;
    readonly outcome: "restored" | "refused";
    /** The writer's or the stage's words, as `StageResult` carries them. */
    readonly reason?: string;
  }[];
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
 * respelled: it kept its range, but its writer now spells the value differently on the new bytes. Or
 * `waiting`: the source's new version does not open, so the edit stays staged against its base until a
 * version that opens arrives (specs/insert-delete/fixes.md FIX-001).
 */
export interface EditNotice {
  readonly source: string;
  readonly path: string;
  readonly outcome: "moved" | "overrides" | "conflicted" | "respelled" | "waiting";
  /** Why the edit was dropped; present exactly when `outcome` is `conflicted`. */
  readonly reason?: ConflictReason;
  /** The edit's new byte range in the source's new version; absent when conflicted. */
  readonly start?: number;
  readonly end?: number;
  /** The bytes on disk that an overriding edit will replace. */
  readonly disk?: Uint8Array;
  /**
   * The writer's words, where a writer's refusal caused the outcome: why the new version does not open (`waiting`), or why
   * it refused the edit (`conflicted` as `gone`, `exists` or `unwritable`; FIX-004). Absent where the session decided alone.
   */
  readonly detail?: string;
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
 * The editing half of a format plug-in (specs/editing/spec.md, specs/insert-delete/spec.md). Pure, like a
 * handler: it reads and writes nothing. `open` parses the bytes once; the document it answers is then asked
 * as often as needed, each answer against the bytes as opened. `path` is the format's own address of a value
 * (a JSON Pointer, a selector and a property); offsets are bytes.
 */
export interface Writer {
  claims(location: string): boolean;
  open(bytes: Uint8Array): WriterOpenResult;
}

/**
 * A writer's refusal: its words, and optionally a code naming why (fixes FIX-003). The session reads three codes, Cascata's
 * names for them: `edit-target-exists` (the key is there), `edit-target-absent` and `edit-parent-scalar` (the place is gone).
 * Any other code, or none, is the writer's own business.
 */
export type WriterRefusal = { readonly ok: false; readonly reason: string; readonly code?: string };

export type WriterOpenResult = { readonly ok: true; readonly document: WriterDocument } | WriterRefusal;

export type WriterLocateResult = { readonly ok: true; readonly start: number; readonly end: number } | WriterRefusal;
export type AmendResult =
  | { readonly inside: false }
  | { readonly inside: true; readonly ok: true; readonly value: EditData }
  | { readonly inside: true; readonly ok: false; readonly reason: string };
export type WriterWriteResult =
  | { readonly ok: true; readonly edit: { readonly start: number; readonly end: number; readonly bytes: Uint8Array } }
  | WriterRefusal;

/** A document a writer has parsed once. */
export interface WriterDocument {
  /** Where the value at `path` is in the bytes as opened, or why it is not there. */
  locate(path: string): WriterLocateResult;
  /** The one splice that sets the value at `path`, in the source's own style, or why it cannot. */
  write(path: string, value: EditData): WriterWriteResult;
  /** The splice that creates the entry at `path`, which must not exist; answers what `write` answers. Absent: the writer cannot insert. */
  add?(path: string, value: EditData): WriterWriteResult;
  /** The splice that deletes the entry at `path`, with the comments attached to it; answers what `write` answers. Absent: the writer cannot delete. */
  remove?(path: string): WriterWriteResult;
  /**
   * Whether `path` lies strictly below `within`, in the format's own path language. Provenance reads no path,
   * so this is how it learns that an edit lands inside a staged edit. Absent: nothing is treated as inside.
   */
  inside?(path: string, within: string): boolean;
  /**
   * `operation` applied inside the value staged at `staged.path`: the amended value, a refusal in the writer's
   * words, or `{ inside: false }` when the operation's path is not below it. Pure; the staged value is not changed.
   */
  amend?(staged: { readonly path: string; readonly value: EditData }, operation: EditOperation): AmendResult;
  /**
   * Whether a list along `path` has a different length in `newer`, a later version of this document opened by
   * the same writer: an index step in it may now name another item. Absent: no guard (a CSS path has no indexes).
   */
  shifted?(path: string, newer: WriterDocument): boolean;
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
