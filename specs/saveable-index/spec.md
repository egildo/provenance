# Feature Specification: Saveable Index — staged edits that survive a reload

**Feature Branch**: `saveable-index` (to be committed on `main`)

**Created**: 2026-10-29

**Status**: Approved by the owner, 2026-10-29: ruling 1 as his own, rulings 2 to 5 and the names as proposed

**Input**: The BelType studio keeps many edits to one document, made of several Markdown and CSS files, in
the browser across page reloads, and commits them all at once: Provenance's commit writes the working copy
(a host over isomorphic-git's in-browser file system), then isomorphic-git records it. Today the index lives
in the session's memory and a reload loses it. Builds on `specs/atomic-commit/`. Terms are
[the glossary's](../../docs/glossary.md).

Prior art: git's index is a file (`.git/index`), so staging survives a restart; Jujutsu snapshots the working
copy continuously, and is already the model for the preview (`docs/write-back.md`).

## The rulings

1. **The diffs live in Provenance's index**, saved and restored by the session, not in a log the
   studio keeps and replays. The edit record already carries what survives: a base version and a semantic
   path.
2. **Restoring is staging against the saved base, then rebasing onto now**. The session
   re-stages each saved edit against the saved base bytes, in saved order, through the writer (never trusting
   saved byte ranges, as a rebase never reuses bytes), then rebases onto the version it holds. A colleague's
   change made while the page was closed is therefore an override, a drop or a carry-over, reported as any
   rebase reports it. Nothing new decides conflicts.
3. **The save carries the base bytes**. The base is the one thing the disk can no longer supply
   once it has moved. Asking the host for a version's bytes (git holds every committed version) is the named
   upgrade, parked; it needs a host verb.
4. **Saving is explicit**. The studio calls it when it wants (after each editor transaction, or
   on page hide). The session does not write the save anywhere: it returns plain data, and storing it
   (IndexedDB) is the embedder's, as all I/O is.
5. **Restoring onto a source that already has staged edits refuses that source**, by name, and
   restores the others. No merging of two indexes.

## Part A — Saving

- **FR-001** `session.save(): SavedIndex`, synchronous, reading the index as it stands. Plain data that
  survives the structured clone (IndexedDB, `postMessage`): no functions, no class instances other than
  `Uint8Array` and `Map`.
- **FR-002** `SavedIndex` is `{ format: 1; sources: { location; base: string /* version */; bytes:
  Uint8Array; edits: { op; path; value?; status; disk? }[] }[] }`, sources and edits in staging order.
  `location` is the canonical location the session stages under. No byte ranges: ruling 2.
- **FR-003** An edit's `overrides` status and its `disk` bytes are saved, so the notice survives a reload
  until the edit is staged again (the status is sticky today).
- **FR-004** A waiting source (its disk version does not open) is saved as any other: its edits against its
  base.

## Part B — Restoring

- **FR-005** `session.restore(saved): Promise<RestoreReport>`, inside `serialize`. A `format` it does not know
  is refused whole.
- **FR-006** Per source, in order: refused by name if not a source in the session's graph, not claimed by a
  writer, already staged (ruling 5), or if `bytes` do not hash to `base`. Otherwise the base is opened, each
  edit is staged against it in saved order (the same checks `stage` makes: overlap, inside, amend), the saved
  `status` and `disk` are put back, and if the version the session holds is not `base` the source is rebased
  onto it.
- **FR-007** An edit the writer now refuses on the saved base (a writer changed between versions) is
  reported, and the source's other edits are restored.
- **FR-008** `RestoreReport` is one entry per saved source: `restored` or `refused` with a reason, and per edit
  `restored` or `refused`. What the rebase then did arrives as the usual `Change` notices (`moved`,
  `overrides`, `conflicted`, `respelled`), announced after the work is kept.
- **FR-009** A throw (a writer bug) rolls the whole restore back through the snapshot, as any piece of work.

## The cases

On the memory host. Source `a.yaml`, one `set` staged, saved, a fresh session opened on the same disk.

1. Disk unchanged: restored; `index()` equals the old session's, byte ranges included; `preview` equal.
2. A colleague added a line above the edit: restored, rebased, notice `moved`; the commit writes it in the new
   place.
3. A colleague changed the same value: restored, notice `overrides` with the colleague's bytes.
4. A colleague deleted the entry: restored then dropped, notice `conflicted` `gone`.
5. Saved with `overrides`: after restore on an unchanged disk the edit is still `overrides`, `disk` equal.
6. Saved bytes tampered (hash mismatch): that source refused, the others restored.
7. Restore onto a session that has an edit staged on `a.yaml`: `a.yaml` refused, others restored.
8. An unknown `format`: refused whole, the index untouched.
9. Two inserts at one spot, saved and restored: the same order in `index()` and the same preview.
10. A staged insert amended (an edit inside it), saved, restored: one edit, the amended value.
11. Round trip through `structuredClone` before restoring: equal to case 1.
12. A writer that throws during restore: the index exactly as before the call.

## Method and limits

`specs/HANDOFF.md` is the working method. The new state is `staged` only, already in the snapshot; check
that the restore adds no other. Do not edit `docs/`; report the glossary entry this wants (an "Index" entry
saying it can be saved). A minor release: additions only.

**Not this round**: the base asked of the host by version (ruling 3); groups in the save (the save's edits
will gain a group name when groups land; `format` exists so that is not a guess); saving automatically;
merging two indexes.

## The names

`session.save()` and `session.restore(saved)`, beside `index()`, which already names the view (owner, 2026-10-29).
