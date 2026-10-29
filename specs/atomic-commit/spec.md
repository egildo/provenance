# Feature Specification: Atomic Commit — every staged file lands, or none does

**Feature Branch**: `atomic-commit` (committed on `main`)

**Created**: 2026-10-29

**Status**: Ruled by the owner, 2026-10-29; rulings 5 and 6 proposed by the coordinator and confirmed by the
owner the same day (implementer: Sonnet)

**Input**: The Codeberg issue "A commit atomic across files, for a document made of includes", from the
BelType studio. A paragraph moved between two chapters is one edit to the user and two files to
Provenance; today a commit is atomic per file only, so a failure on the second file leaves the move
half-applied. [`docs/vision.md`](../../docs/vision.md) names the answer ("best-effort renames with
rollback, or a small journal"); [`docs/write-back.md`](../../docs/write-back.md) parks it ("Saving several
files at once … back when one edit spans two files"). Terms are [the glossary's](../../docs/glossary.md).

Prior art: the Language Server Protocol's `WorkspaceEdit.failureHandling`, whose `undo` value means "if one
change fails, undo the ones already applied". That is this round. Mercurial's transaction journal (undo
after a crash, `hg recover`) is the named upgrade, parked.

## The rulings

1. **The commit is the unit.** A commit lands every staged source, or none. There is no partial commit
   of the index (git's index: you commit what is staged, or fix what is wrong first).
2. **What aborts.** Anything that today leaves a source, or an edit, not written: an edit dropped on
   rebase (`conflicted`, any reason), a source `refused` (outside the writable roots, the host cannot
   write, the disk version does not open), a source `failed` (the host's read or write failed).
3. **What does not abort.** An override (last saver wins, per value, with its notice): both halves of a
   move land, so the move is whole.
4. **Groups are parked, and must stay addable.** The glossary already defines a group. They will come
   soon (the studio's ProseMirror history events are the natural groups). The engine below therefore works
   on *a set of staged sources*, not on "the whole index"; this round always passes the whole index. The
   hard part groups bring — committing some of one file's edits and rebasing the rest onto the version the
   session wrote — is the next round's, not this one's.
5. **Always, not a mode** *(confirmed)*. A commit always aborts on ruling 2; there is no
   per-commit option. The issue allows either; a mode can be added later without breaking anyone.
6. **Putting a file back checks first** *(confirmed)*. Before writing a file's old bytes back,
   the session reads the disk: if it no longer holds the version this commit wrote (a colleague saved
   since), the file is left alone and reported. Putting back must never overwrite a colleague.

## Part A — Two phases

- **FR-001 Prepare.** For every staged source, in staging order, do today's checks and rebase (sandbox,
  host `write` present, read the disk, rebase if its version is not the base, waiting check), and build the
  bytes to write. Nothing touches disk. Rebase notices are kept whatever follows: the session now holds
  the disk's newer version either way.
- **FR-002 Abort before writing.** If any source met ruling 2 during prepare, nothing is written. Every
  edit not dropped stays staged, on the version prepare rebased it onto.
- **FR-003 Write.** Otherwise write every prepared source, in staging order, remembering each one's
  disk bytes from prepare.
- **FR-004 Undo.** If a write fails, put back every source this commit already wrote, newest first, with
  the host's `write` and the bytes remembered in FR-003, after ruling 6's check. Then the commit is
  aborted as in FR-002, for the sources that were put back as for the rest.
- **FR-005 After success** the index empties for every written source and the session's nodes catch up,
  as today. A source put back keeps its old node and its staged edits.
- **FR-006 No new host verb.** `Host` keeps `read` and an optional `write`. The Node host's per-file
  temporary-file-then-rename stays as it is.

## Part B — The report

The report keeps its shape: one entry per source, in staging order. Additions only:

- **FR-007** `CommitReport.outcome`: `"committed" | "aborted"`. An empty index is `committed` with no
  sources.
- **FR-008** A source's `outcome` in an aborted commit is the cause's own (`refused`, `failed`,
  `conflicted`) for a source that caused it, and the new `aborted` for every other source, put back or
  never written. `reason` on an `aborted` source names the source that caused the abort.
- **FR-009** A source this commit wrote and could not put back (its write back failed, or ruling 6 found a
  newer version) has the new outcome `unrestored`, with `reason` saying which. Its edits are on disk: they
  leave the index, as a written source's do, and its `edits` list them as `written` or `overrode`.
- **FR-010** `conflicted` on a source now means "at least one edit was dropped", and its `edits` list the
  dropped ones. (Today it means every edit was dropped; with ruling 2 a single drop aborts.)

## Part C — Rollback and the snapshot

- **FR-011** An aborted commit is a commit that *returns*, not one that throws: the piece of work is kept,
  its notices are announced, nothing is restored by `serialize`'s snapshot.
- **FR-012** A throw mid-commit (a writer bug) keeps today's behaviour: the snapshot restores, written
  sources' edits leave the index. Report whether the undo of FR-004 should also run on a throw; do not
  decide it.
- **FR-013** Any new piece of session state goes into the snapshot and the restore
  (`specs/HANDOFF.md`).

## The cases

On the memory host unless said. Two sources `a` and `b`, each with a staged edit, committed together.

1. Both clean: both `written`, report `committed`.
2. `b`'s edit is dropped on rebase (its target gone): nothing written; `a` is `aborted` naming `b`, `b` is
   `conflicted`; `a`'s edit stays staged; the disk of `a` is byte-identical.
3. `b` is outside every writable root: nothing written; `a` `aborted`, `b` `refused`.
4. `b`'s disk version does not open (waiting): nothing written; `a` `aborted`, `b` `refused`.
5. `b`'s edit overrides a colleague's newer value: both `written`, `b`'s edit `overrode`, report
   `committed`.
6. The host's write fails on `b` (a host wrapper failing the second write): `a` is put back
   (byte-identical to before the commit), `a` `aborted`, `b` `failed`; both edits stay staged.
7. As 6, and a colleague saves `a` between its write and the put-back: `a` is left as the colleague saved
   it, `unrestored`; `a`'s edit leaves the index.
8. As 6, and the put-back write of `a` fails too: `a` `unrestored`.
9. A partial drop in one source alone (two edits, one dropped): nothing written, the source `conflicted`,
   its surviving edit stays staged.
10. Three sources, the third fails to write: the first two are put back, newest first (the host wrapper
    records the order).
11. Real disk (Node host), case 6 forced by a read-only file: the first file's bytes and mode are as
    before.

## Method and limits

`specs/HANDOFF.md` is the working method: tests first, expected values by hand, sabotage each claim,
commit each green step by explicit path, never push, no version bump. **Do not edit `docs/`**; the
glossary's "Commit" ("one file at a time, each atomically") and `write-back.md`'s parked item change
through the coordinator: report the wording you would want. Existing tests that assert a write after a
partial drop now go red by design: change them, and name each one in the report. Write
`specs/atomic-commit/report.md` at the end, ambiguities unsoftened.

**Not this round**: groups and partial commit (ruling 4), a mode (ruling 5), a journal for a process that
dies mid-commit, and closing the window between ruling 6's read and the put-back write
(`ponytail:` comment naming it).
