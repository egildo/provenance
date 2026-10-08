# Feature Specification: Joining — the walking skeleton, end to end

**Feature Branch**: `joining` (committed on `main`)

**Created**: 2026-10-08

**Status**: Draft

**Input**: the last step of the write-back plan (`docs/write-back.md`, "The first build"): a tool reads
a cascade and a dataset, edits a value, and the edit lands in exactly the right bytes. Provenance's
editing stage (`specs/editing/`) and Cascata 1.10–1.11 (Article IX: `setValue`, `editTarget`, the
YAML and JSON writers) are the two halves. **This milestone starts after `@egildo/cascata@1.11.0` is
published.**

## Requirements

- **FR-001** **Cascata is a development dependency only.** `@egildo/cascata` (^1.11.0) enters
  `devDependencies`, never `dependencies`; nothing under `src/` imports it, and a sweep beside the
  realm sweep enforces that. The two libraries meet by shape, as they already do for the host.
- **FR-002** **The respelling notice** (`specs/editing/spec.md` FR-008, as amended): a rebase that
  keeps an edit's range but changes its bytes is reported in `Change.edits`, like a move.
- **FR-003** **The geometry fixture**, under `test/fixtures/geometry/`, written by hand:
  - `house.schema.yaml` — a root schema: `walls` items demand `height` (a decimal) — *as built: not `id`,
    since walls are keyed by id and an item cannot also demand it (corrected after implementation)*;
    `provide`s `defaults: { height: 3.0 }`;
  - `project.yaml` — a config adopting it, with `walls` keyed by id (`W1`, `W2`), each with `height`;
  - `walls.yaml` — the running file of `docs/write-back.md`, 51 bytes, as a data file.
- **FR-004** **The loop, as one test per law**, through a real session with Cascata's writers and the
  memory host: open a session on the fixture; load the cascade with Cascata through a read pass's
  host; for a merged pointer, ask `editTarget`; `stage` at the location and pointer it answers;
  `commit`; load again and read the value. Cases 1 to 10 of `docs/write-back.md`'s "Cases on paper",
  each with its expected bytes copied from that document (they were counted by hand there), run this
  way. Case 11 (CSS) needs a CSS writer and is out of scope.
  *As built: cases 1–10 are about `walls.yaml`, a data file no cascade adopts, so they go straight to
  `stage` through `yamlWriter()`; the loop through `editTarget` runs on `project.yaml` (FR-005).
  Corrected after implementation: the spec had asked for both in one loop.*
- **FR-005** **The cascade, end to end**: editing `/defaults/height` is refused by `editTarget` as
  inherited, naming `house.schema.yaml`, and nothing is staged; editing `/walls/W1/height` lands in
  `project.yaml` and nowhere else.
- **FR-006** **One run on a real disk**: cases 1 and 3 through the Node host on a temporary directory,
  with `writable` granted to it, so the atomic write and the watcher's own-write absorption are
  exercised for real.
- **FR-007** **Write-back's laws hold across the join**: after every commit, Cascata reads the
  committed file and the value at the pointer is the one set (L2), and every byte outside the edit's
  range is unchanged (L3).

## Sabotage

Each watched red and restored: swap in a writer that reuses old bytes on rebase (case 3 red); grant no
`writable` (every commit case red); skip `editTarget` and stage the merged pointer on the entry
document (the inherited case red); a writer that ignores CRLF (case 7 red).

## Not in this milestone

A CSS writer; inserting or deleting; groups; stamps (#6); Markdown units (#2); the view-update policy.

## Plan and tasks

One plan file. Commits, `npm test` green at each: (1) FR-001, FR-002; (2) the fixture and FR-004;
(3) FR-005 to FR-007; (4) `specs/joining/report.md`. Then the owner decides the release (0.5.0, with
the editing stage).
