# Feature Specification: Editing — staged edits, preview, rebase, commit

**Feature Branch**: `editing` (committed on `main`)

**Created**: 2026-10-08

**Status**: Draft

**Input**: [egildo/provenance#4](https://github.com/egildo/provenance/issues/4), from the design in
[`docs/write-back.md`](../../docs/write-back.md), approved by the owner on 2026-10-08. Terms are
[the glossary's](../../docs/glossary.md), whose editing entries were amended the same day: an edit
carries two addresses; rebase finds an edit by its semantic address; the last to commit wins, per
value, with a notice; *conflicted* means the target is gone.

This is the first slice of the vision's editing stage: **set a value**, one source at a time, no
groups, no file operations. Its format plug-in in tests is a test-only one in this repository, the
way the `include` handler tests the kernel. The real YAML and JSON plug-in is Cascata's
(egildo/cascata#7, built in parallel); the two meet by shape (#5), not by import.

## Requirements

**The plug-in and the host**

- **FR-001** A **writer** is the editing half of a format plug-in (#5):
  `{ claims(location): boolean; locate(bytes, path): { ok: true; start; end } | { ok: false; reason };
  write(bytes, path, value): { ok: true; edit: { start; end; bytes } } | { ok: false; reason } }`.
  `path` and `value` are opaque to Provenance; the writer owns them. Writers are pure, like handlers:
  no reads, no writes. `openSession` takes `writers?: readonly Writer[]`; the first that claims a
  location is its writer.
  *As built: `path` is a string, so edits at one path can be compared and replaced. `value` was opaque
  (`unknown`) until `specs/fixes-0.5/`: it is now `EditValue`, the scalar union Cascata uses.*
- **FR-002** `Host` gains an **optional** `write(location, bytes): Promise<{ ok: true } | { ok: false;
  reason }>`. Optional, like Cascata's verbs: a host without it can stage and preview, and commit
  refuses. The Node host writes atomically per file — a temporary file in the same directory, then a
  rename — and the memory host writes in place.
- **FR-003** **The write sandbox.** `openSession` takes `writable?: readonly string[]`, locations
  under which a commit may write, judged against canonical locations with the host's `paths`.
  Absent means **nothing is writable**: writing is granted, never ambient. A source outside every
  writable root can be staged and previewed, and its commit is refused.

**Staging and the index**

- **FR-004** `session.stage(location, path, value)` stages a **set** edit: the source must be in the
  session's graph and read (not external, not refused); a writer must claim it; the writer's `write`
  on the source's **base** bytes gives the byte address. Refusals (no writer, the writer's own
  refusal, an unknown source) resolve as `{ ok: false, reason }`, never throw. Staging at a path that
  already has a staged edit **replaces** it (the glossary's base version: never an edit against
  another edit's result).
  *Amended after the first build: staging never refuses because the disk moved since the session
  last read it. The edit is staged against the base the session holds, and the rebase moves it.*
- **FR-005** `session.index()` lists the staged edits: source id, path, value, base version, start,
  end, and status — `"staged"` or `"overrides"` (FR-008). `session.unstage(location, path?)` drops
  one edit, or every edit of a source.
- **FR-006** `session.preview(id)` returns the source's base bytes with every staged edit spliced in,
  applied from the end backwards, and the preview's version (its SHA-256). Staged edits on one source
  never overlap: two paths whose ranges overlap are a writer bug, refused at staging.
  *Amended (`specs/fixes-0.5/`): overlap at staging is a writer bug; overlap after a rebase is not —
  the text moved — so a rebase rechecks it, and the later-staged of two overlapping edits is conflicted
  (a restaged edit counts as staged last).*
- **FR-007** Staging, unstaging and commit are session work: serialized, and rolled back on a throw
  like every other piece (the kernel's `broken-is-reported-not-thrown`). A preview is held like any
  version under `cache-by-handler-and-hash` while its edits are staged.

  *As built: a preview is analysed when `preview()` is called, and its version is held while its
  edits stand; nothing exposes its findings yet.*

**Rebase and commit**

- **FR-008** **Rebase.** When the host reports a new version of a source with staged edits, each
  edit asks its writer to `locate` its path in the new bytes:
  - found, and the bytes there equal the bytes at the edit's range in its old base → the edit moves
    (new range, new base), status `"staged"`; its replacement bytes are **written again** by the
    writer on the new bytes, never reused, because a value's spelling can depend on its neighbours;
  - found, and the bytes differ → the value changed on disk; the edit moves and its status becomes
    `"overrides"`, carrying the disk's bytes so the embedder can say what will be overwritten;
  - gone → the edit is **conflicted**: dropped from the index and reported.
  Every move, override, drop and respelling (same range, different bytes) is reported to change
  listeners: `Change` gains an optional
  `edits` member listing them. Nothing silent.
- **FR-009** **Commit.** `session.commit()` writes every source with staged edits, one file at a time,
  each atomically (FR-002). For each: read the disk; if its version is not the base, rebase first
  (FR-008); then write the preview through `host.write`. The written version becomes the base and the
  source's edits leave the index. It resolves to a report: per edit, `written`, `overrode` (with the
  disk bytes replaced) or `conflicted`; per source, `written`, `refused` (outside the sandbox, or no
  `write` verb) or `failed` (the host's reason, its edits kept). A failure on one source does not stop
  the others; a commit is not atomic across files, and the report says exactly what landed.
  *As built: a source whose every edit is conflicted at commit reports `conflicted`; a commit that
  cannot read the disk reports `failed` and keeps the edits, while the watcher treats a vanished file
  as conflicted — the host cannot tell a transient error from a deletion.*
- **FR-010** After a commit, the session absorbs its own writes as it absorbs any change: written
  sources are re-read and re-analysed, so validation is re-analysis.

## The laws, as cases

A test-only writer for a `key=value` line format: path is the key, value a string, `locate` gives
the value's range after `=`, `write` gives the value's UTF-8 bytes. Expected values by hand; the file
`/w.conf` is `a=1⏎b=2⏎`, 8 bytes, `a`'s value at 2–3, `b`'s at 6–7.

| # | Story | Expect | Law |
|---|---|---|---|
| 1 | stage `b` = `3`; commit | index entry 6–7; preview `a=1⏎b=3⏎`; disk the same | L2, L3 |
| 2 | commit with nothing staged | `host.write` never called | L1 |
| 3 | stage `b` = `3`; the disk becomes `# note⏎a=1⏎b=2⏎`; commit | rebased to 13–14, `"staged"`; disk `# note⏎a=1⏎b=3⏎` | L4 |
| 4 | stage `b` = `3`; the disk becomes `a=1⏎b=5⏎`; commit | `"overrides"` with `5`, reported; disk `a=1⏎b=3⏎`; report `overrode` | L5 |
| 5 | stage `b` = `3`; the disk becomes `a=9⏎b=2⏎`; commit | `"staged"`; disk `a=9⏎b=3⏎` | L5 |
| 6 | stage `b` = `3`; the disk becomes `a=1⏎` | conflicted, dropped, reported; commit writes nothing | — |
| 7 | stage `b` = `3`, then `b` = `4` | one entry; preview `a=1⏎b=4⏎` | — |
| 8 | stage `a` = `77` and `b` = `3`; commit | disk `a=77⏎b=3⏎`, 9 bytes | L3 |
| 9 | stage `b` = `3`; commit with no `writable` | refused, disk unchanged, edit kept | — |
| 10 | stage on a location outside the graph | `{ ok: false }` | — |
| 11 | stage `b` = `3`; the host's `write` fails | report `failed` with the reason, edit kept | — |
| 12 | case 1, then commit again | nothing written | L1 |
| 13 | stage `b` = `3` with `/w.conf` writable and `/x.conf` not, both staged; commit | `/w.conf` written, `/x.conf` refused | — |

Plus one Node-host test on a temporary directory: a commit writes through a temporary file and a
rename, so a reader never sees half a file.

**Sabotage**, each watched red and restored (back up, mark `SABOTAGE`, grep before every commit):
apply edits front to back (case 8 red); rebase by the old range instead of by path (case 3 red); skip
the changed-bytes comparison (case 4 red on status); treat absent `writable` as everything (case 9
red); stack edits at one path (case 7 red).

## Not in this milestone

Groups and confirmation; file operations (create, delete, rename); inserting and deleting nodes;
several files atomically; Markdown units (#2); stamps (#6); the real YAML plug-in (Cascata's); the
cascade question (which document an edit to a merged value belongs in).

## Plan and tasks

One plan file. Commit each step the moment `npm test` is green, by explicit path, never pushed:

1. **Host and writer** — FR-001 to FR-003; the Node host's atomic write and its test.
2. **Stage, index, preview** — FR-004 to FR-007; cases 7, 8, 10.
3. **Rebase** — FR-008; cases 3 to 6.
4. **Commit** — FR-009, FR-010; cases 1, 2, 9, 11 to 13.
5. **Report** — `specs/editing/report.md`, with every place this spec, the glossary or
   `docs/write-back.md` was silent or wrong.

Do not bump the version. Do not edit `docs/` or the kernel specification; report what should
change. The contract (`specs/source-graph-kernel/contracts/public-api.md`) gains the new surface as
part of step 5.
