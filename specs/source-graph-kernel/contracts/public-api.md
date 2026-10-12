# Contract: public API

Everything exported, and nothing else (*Small public surface*). Five entry points, so an
embedder loads only what it uses (`pay-for-loaded-handlers`).

| Entry point | Exports | Loads |
| --- | --- | --- |
| `@egildo/provenance` | `openSession`, the types below | nothing outside the core |
| `@egildo/provenance/css` | `css: Handler` | `postcss`, `postcss-safe-parser`, `postcss-value-parser` |
| `@egildo/provenance/html` | `html: Handler` | `parse5` |
| `@egildo/provenance/memory` | `createMemoryHost` | nothing outside the core |
| `@egildo/provenance/node` | `createNodeHost` | `node:fs`, `node:path`, `node:os` |

## Core

```ts
function openSession(options: {
  host: Host;
  entry: string;                       // a location the host understands
  handlers: readonly Handler[];        // registration order breaks ties
  resolvers?: readonly Resolver[];     // tried before the shipped ones
  writers?: readonly Writer[];         // the editing half of format plug-ins; the first to claim wins
  writable?: readonly string[];        // locations a commit may write under; absent = nothing is writable
}): Promise<Session>;

interface Session {
  read(label?: string): ReadPass;      // default label ""; discards an open pass with the same label
  sources(): readonly Source[];
  source(id: string): Source | undefined;
  edgesFrom(id: string): readonly Edge[];
  edgesInto(id: string): readonly Edge[];
  unresolved(): readonly Edge[];
  cycles(): readonly (readonly string[])[];
  addRoot(location: string): Promise<void>;
  removeRoot(location: string): Promise<void>;
  onChange(listener: (change: Change) => void): () => void;
  stage(location: string, operation: EditOperation): Promise<StageResult>;   // editing: below; insert-delete
  index(): readonly StagedEdit[];
  unstage(location: string, path?: string): Promise<void>;
  preview(id: string): Promise<Preview | undefined>;
  commit(): Promise<CommitReport>;
  close(): void;                       // final: queued or running work changes nothing after it
}

interface ReadPass {                   // specs/read-passes/spec.md
  readonly host: SessionHost;          // hand this to Cascata, or spread it into a composed host
  note(location: string): void;        // a location read outside `host.read`, such as a code module
  end(): Promise<RenderManifest>;      // replaces the label's roots and settles once
}

interface RenderManifest {
  readonly read: readonly { readonly source: string; readonly version: string }[];
  readonly missing: readonly string[];   // locations; a note with nothing readable there is listed here
}

type Source = {
  readonly id: string;
  readonly location: string;
} & (
  | { readonly state: "analysed" | "leaf" | "undecodable"; readonly version: string }
  | { readonly state: "refused"; readonly reason: string }
  | { readonly state: "external" }
);

interface Address { readonly source: string; readonly version: string; readonly start?: number; readonly end?: number }

interface Edge {
  readonly from: Address;
  readonly request: string;
  readonly target?: string;
  readonly kind: "requires" | "candidate";
  readonly origin: "declared";
  readonly probes: readonly string[];
}

interface Change {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly edits?: readonly EditNotice[];   // absent unless a rebase moved, overrode or dropped a staged edit
}
```

## Editing

Specified in [`specs/editing/`](../../editing/spec.md); terms are the glossary's. Staging, unstaging,
previewing and committing are session work, serialized and rolled back like any other (a refusal
resolves; a throw rejects and leaves the session as it was).

```ts
interface Writer {                     // pure, like a handler; paths and values are the format's own (insert-delete)
  claims(location: string): boolean;
  open(bytes: Uint8Array): { readonly ok: true; readonly document: WriterDocument } | WriterRefusal;
}

interface WriterDocument {             // the bytes opened once; every answer is against them
  locate(path: string): { readonly ok: true; readonly start: number; readonly end: number } | WriterRefusal;
  write(path: string, value: EditData): WriterWriteResult;
  add?(path: string, value: EditData): WriterWriteResult;          // absent: the writer cannot insert
  remove?(path: string): WriterWriteResult;                        // absent: the writer cannot delete
  inside?(path: string, within: string): boolean;                  // absent: nothing is inside anything
  amend?(staged: { readonly path: string; readonly value: EditData }, operation: EditOperation): AmendResult;
  shifted?(path: string, newer: WriterDocument): boolean;          // absent: no shift guard
}

type WriterWriteResult = { readonly ok: true; readonly edit: { readonly start: number; readonly end: number; readonly bytes: Uint8Array } } | WriterRefusal;
/** `code` (fixes FIX-003): the session reads `edit-target-exists` (the key is there), `edit-target-absent` and `edit-parent-scalar` (gone). */
type WriterRefusal = { readonly ok: false; readonly reason: string; readonly code?: string };
type AmendResult = { readonly inside: false } | { readonly inside: true; readonly ok: true; readonly value: EditData } | { readonly inside: true; readonly ok: false; readonly reason: string };

/** The same union, under the same name, as Cascata's (a `Map` for a mapping, never a plain object). */
type EditData = string | number | bigint | boolean | null | readonly EditData[] | ReadonlyMap<string, EditData>;
/** JSON Patch's operation object, with Cascata's verb names. */
type EditOperation = { readonly op: "set" | "add"; readonly path: string; readonly value: EditData } | { readonly op: "remove"; readonly path: string };

type StageResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

interface StagedEdit {
  readonly source: string;             // a source id
  readonly path: string;
  readonly op: "set" | "add" | "remove";
  readonly value?: EditData;           // absent for remove
  readonly base: string;               // the base version the byte address is against
  readonly start: number;              // bytes in the base version
  readonly end: number;
  readonly status: "staged" | "overrides";
  readonly disk?: Uint8Array;          // what an overriding edit will replace
  readonly waiting?: string;           // while the newest version does not open: the writer's words (FIX-001)
}

interface Preview { readonly bytes: Uint8Array; readonly version: string }   // version: SHA-256, hex

interface EditNotice {                 // one per edit a rebase moved, found overriding, dropped, or left waiting
  readonly source: string;
  readonly path: string;
  readonly outcome: "moved" | "overrides" | "conflicted" | "respelled" | "waiting";   // respelled: same range, new bytes
  readonly reason?: ConflictReason;    // present exactly when conflicted
  readonly start?: number;             // the new range; absent when conflicted or waiting
  readonly end?: number;
  readonly disk?: Uint8Array;
  readonly detail?: string;            // the writer's words where its refusal caused this: waiting, or conflicted gone/exists/unwritable
}

/**
 * Why a staged edit was dropped: its path is no longer found, or its source left the graph (`gone`); its new range
 * overlaps an earlier-staged edit's (`overlap`); its writer refuses on the new bytes (`unwritable`); an insert's key
 * was added on disk (`exists`); a deleted entry was changed on disk, attached comments included (`changed`); a list
 * along its path changed length (`shifted`). A set overrides a value changed on disk; an insert or a delete never
 * overwrites a colleague's work on the same entry.
 */
type ConflictReason = "gone" | "overlap" | "unwritable" | "exists" | "changed" | "shifted";

interface CommitReport { readonly sources: readonly SourceCommit[] }
interface SourceCommit {
  readonly source: string;
  readonly location: string;
  readonly outcome: "written" | "refused" | "failed" | "conflicted";
  readonly reason?: string;
  readonly version?: string;           // the version written
  readonly edits: readonly { readonly path: string; readonly outcome: "written" | "overrode" | "conflicted"; readonly reason?: ConflictReason; readonly detail?: string; readonly disk?: Uint8Array }[];
}
```

`stage` refuses (resolves `{ ok: false }`) a location outside the graph, one no writer claims, the
writer's own refusal, and an edit whose
range overlaps another staged edit's. A writer's range outside the bytes it was given throws a
`RangeError`. `commit` is not atomic across files: its report says what landed.

## Handlers

```ts
interface Handler {
  claims(location: string): boolean;
  analyze(text: string): Findings;     // pure; throwing is a bug: it rejects the call whose work met it,
                                       // which leaves the session unchanged, or escapes when no call did
}

interface Findings {
  readonly requests: readonly {
    readonly start: number;            // string index, inclusive
    readonly end: number;              // string index, exclusive
    readonly request: string;
    readonly kind: "requires" | "candidate";
  }[];
  readonly base?: string;
}
```

`css` claims `*.css`. `html` claims `*.html` and `*.htm`. Neither analyses embedded regions.
The CSS handler's rules are in [research.md](../research.md#css-handler). The HTML handler's:

| Attribute | Kind |
| --- | --- |
| `link href`, `rel` containing `stylesheet` | `requires`; `candidate` if it has `media` or `rel` has `alternate` |
| `link href`, `rel` containing `icon`, `preload`, `modulepreload` or `prefetch` | `candidate` |
| `img src`, `iframe src` | `requires`; `candidate` if `loading="lazy"` |
| `img srcset`, `source src` and `srcset`, `video src` and `poster`, `audio src` | `candidate` |
| `object data`, `script src`, SVG `use href` and `xlink:href` | `requires` |
| `base href` | the base, not an edge |

A `link` with any other `rel`, and every `a href`, is navigation or metadata, not a load, and
makes no edge. A `use href` that is only a fragment (`#icon`) points into the same document and
makes no edge.

## Resolvers

```ts
type Resolution =
  | { readonly probes: readonly string[]; readonly target?: string }     // local; target is canonical
  | { readonly external: string }                                        // never read
  | null;                                                                // no edge at all

interface Resolver {
  claims(request: string): boolean;
  resolve(request: string, base: string, host: Host): Promise<Resolution>;   // base: a directory, or a web URL
}
```

## Host

```ts
type HostReadResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: string };

interface PathFacility {               // Cascata's shape
  readonly separator: string;
  readonly homeDirectory: string | undefined;
  dirname(path: string): string;
  isAbsolute(path: string): boolean;
  resolve(base: string, segment?: string): string;
}

type HostWriteResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

interface Host {
  read(location: string): Promise<HostReadResult>;            // Cascata's
  write?(location: string, bytes: Uint8Array): Promise<HostWriteResult>;   // optional; atomic per file
  canonicalize(location: string): Promise<string | undefined>; // Cascata's; undefined = nothing there
  readonly paths: PathFacility;                                // optional in Cascata, required here
  watch(onChange: (locations: readonly string[]) => void): {
    set(locations: readonly string[]): void;                   // the whole watched set, replaced
    close(): void;
  };
}

interface SessionHost {                // satisfies Cascata's Host by shape; no member uses `this`
  read(location: string): Promise<HostReadResult>;             // recorded by the pass
  canonicalize(location: string): Promise<string | undefined>; // `undefined` is recorded as missing
  cacheRead(key: string): Promise<Uint8Array | undefined>;     // always undefined
  cacheWrite(key: string, bytes: Uint8Array): Promise<void>;   // throws: no cache configured
  readonly paths: PathFacility;
}
```

```ts
// @egildo/provenance/memory
function createMemoryHost(files?: Record<string, string | Uint8Array>): Host & {
  write(location: string, content: string | Uint8Array): Promise<HostWriteResult>;   // create or change in place; notifies
  remove(location: string): void;                                 // notifies
  refuse(location: string, reason: string): void;                 // reads fail with reason
};

// @egildo/provenance/node
function createNodeHost(options?: { debounce?: number }): Host;   // default 300 ms; `write` is a temporary file, then a rename
```

The memory host uses POSIX paths and delivers events at the next microtask, so changes made in
one synchronous run arrive as one batch.
