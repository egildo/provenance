# Feature Specification: Read passes

**Feature Branch**: `read-passes`

**Created**: 2026-09-24

**Status**: Draft

**Input**: [egildo/provenance#1](https://github.com/egildo/provenance/issues/1), "Read passes: an
embedder's reads through the session become its roots, replaced per render, misses watched".

An embedder that reads *through* the session makes those reads the session's roots, exactly: what
a render read is watched, what it tried and found nothing at is watched, and what the next render
stops reading leaves. This replaces the add-only `session.host` of 0.1.0. Terms are
[the glossary's](../../docs/glossary.md); the kernel this builds on is
[source-graph-kernel](../source-graph-kernel/spec.md).

**Why `session.host` goes.** Measured against 0.1.0's code, each of these is real:

1. Roots from reads never leave: every successful read calls `addRoot`, and nothing removes one.
2. A failed read leaves nothing watched: a root is added only when the read succeeds.
3. An existence miss (`canonicalize` answering `undefined`) is passed through and forgotten.
4. Every read settles the whole session, and waits behind queued session work.
5. The session reads the file a second time to hash it, so the version it records can differ from
   the bytes the render was handed.

**Decided 2026-09-24** (the issue's open questions):

- A miss becomes a root owned by the pass, in state `refused`, as a missing entry already is. A
  file appearing there is reported as `changed`; `Change` keeps its shape.
- One live pass per label. Starting a pass under a label whose pass has not ended discards the
  unfinished one: its `end()` still returns its manifest, and changes nothing.
- `session.host` is removed; passes are the one way reads become roots (*Small public surface*).
- Code read outside `read`, such as a plugin module, is recorded with `pass.note(location)`.

**Out of scope:** the Markdown include handler, the closure and virtual sources for rendered
output, observation, and editing.

## User Scenarios & Testing *(mandatory)*

The user is an embedder rendering a document through a host it hands to its readers (Cascata,
its own include reader), BelType first:

```js
const pass = session.read("render");
try {
  await pipeline.build({ host: compose(pass.host) });
} finally {
  const manifest = await pass.end();
}
```

### User Story 1 - A render's reads are the session's roots (Priority: P1)

**Independent Test**: two passes with one label over a memory host, compared with the roots and
watched set each leaves.

**Acceptance Scenarios**:

1. **Given** a pass that reads A and B, **When** a second pass with the same label reads A and C
   and ends, **Then** B is no longer a source or watched, C is, and the second `end()` reports one
   change.
2. **Given** a pass whose reader threw after reading A, **When** the embedder ends it in a
   `finally`, **Then** it still replaces its predecessor.
3. **Given** roots added with `addRoot`, **When** passes come and go, **Then** those roots stay.

### User Story 2 - What a render could not read is watched (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a pass whose read of `house.yaml` fails, **When** the file is created, **Then** the
   session reports it once as `changed`, and the next pass reads it.
2. **Given** a pass in which `canonicalize` answers `undefined` for a location, **Then** that
   location is watched and reported the same way.

### User Story 3 - The manifest names the bytes the render used (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a pass that reads N files, **When** it ends, **Then** the session settles once, not
   N times, and no read waited on session work.
2. **Given** a file rewritten after the pass read it and before `end()`, **Then** the manifest's
   version is the SHA-256 of the bytes the pass handed out, and the rewrite is reported as a change.

### Edge Cases

- `close()` while a pass is open: `end()` resolves with its manifest and watches nothing.
- A pass discarded by a newer one under its label: `end()` returns its manifest and changes
  nothing.
- A location a composed host answers itself never reaches `pass.host`, so it is neither read nor
  missing.

## Requirements *(mandatory)*

### Functional Requirements

- **`read-starts-a-pass`**: `session.read(label?)` MUST return a pass whose `host` records every
  read and every existence miss made through it. The default label is `""`.
- **`pass-host-is-cascata-shaped`**: `pass.host` MUST satisfy Cascata's `Host` by shape, and its
  members MUST NOT depend on `this`, so an embedder may spread it into a composed host. It
  supersedes `source-graph-kernel/host-fits-cascata`.
- **`reads-record-not-settle`**: A read through `pass.host` MUST return the host's result without
  waiting on session work, and record the location with the SHA-256 of the bytes it returned.
  Nothing touches the graph before `end()`.
- **`misses-are-recorded`**: A refused read and a `canonicalize` answering `undefined` MUST be
  recorded as missing.
- **`note-records-code`**: `pass.note(location)` MUST record a location read outside `read`, such as
  a code module, as read by the pass.
- **`end-replaces-predecessor`**: `pass.end()` MUST make the pass's recorded locations, read,
  noted and missing, the roots its label contributes, replacing the previous pass's with that
  label, and settle once. Roots added with `addRoot` are never touched by a pass. It supersedes
  the host-read clause of `source-graph-kernel/embedder-adds-roots`.
- **`end-returns-manifest`**: `end()` MUST return a render manifest: each location read or noted,
  as a source id with the version the pass saw (for a read, the version of the bytes it returned;
  for a note, the version the session reads at `end()`), and each missing location.
- **`manifest-mismatch-is-a-change`**: A location whose version in the session differs, after
  `end()`, from the version in the manifest MUST be reported in `changed`, once.
- **`one-live-pass-per-label`**: `read(label)` while a pass with that label is open MUST discard
  the open one; the discarded pass's `end()` returns its manifest and changes nothing.
- **`end-after-close-changes-nothing`**: `end()` after `close()` MUST return the manifest and
  neither settle nor watch.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **`one-settle-per-pass`**: a pass reading 40 files causes one settle and one watched-set update.
- **`beltype-drops-its-read-set`**: BelType's second adoption slice builds its read-set and watched
  set from pass manifests alone, with no `addRoot` for reads. Measured in BelType.
