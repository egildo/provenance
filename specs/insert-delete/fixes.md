# Fixes after the insert-delete report (2026-10-12, by the coordinator)

From `report.md`'s findings 1, 2 and 3. Cases in `test/waiting-and-codes.test.ts`, written by hand before the code.

- **FIX-001 — a version that does not open makes the edits wait** (the owner's ruling, finding 3). A colleague's editor
  autosaves mid-typing, and the file briefly does not parse: the staged edits are no longer dropped as `unwritable`.
  They stay staged against their base, each reported once per such version with the outcome `waiting` and the writer's
  words (`detail`); `index()` carries `waiting` on each; the preview is unchanged; a commit of that source is refused
  ("the file on disk does not open: …") and writes nothing; the next version that opens is rebased onto as usual.
  Sabotage: dropping instead of waiting (3 red); the commit ignoring it (1); never clearing it (1).
- **FIX-002 — `changed` compares what the delete would cut** (finding 2). The comparison was the located value's bytes,
  so a comment a colleague attached to the entry was invisible and the delete took it — a colleague's work overwritten,
  against ruling 5. It is now the bytes the delete cuts on the new version against the bytes it cut on the base (the
  staged edit's own range): the entry, its same-line comment and its attached comments. A comment elsewhere moves the
  delete and does not stop it. Sabotage: the old located-bytes comparison (1 red); no comparison (4).
- **FIX-003 — a refusal's code says why** (finding 1). Paths are opaque, so a rebased insert's refusal could only be
  classified by locating the key again, which mislabels an index insert. `WriterRefusal` gains an optional `code`;
  the session reads three, Cascata's names: `edit-target-exists` → `exists`; `edit-target-absent` and
  `edit-parent-scalar` → `gone`; any other code → `unwritable`; no code → the old look-up. A delete's refusal reads the
  same gone codes. Cascata's writers give codes from 1.16.1 (its `specs/026-shift-and-amend` FR-005); with 1.16.0 the
  look-up still serves. Sabotage: codes ignored (3 red); no gone codes (2).

- **FIX-004 — a notice carries the writer's words** (open edge 1). Wherever a writer's refusal caused an outcome — a
  rebased edit conflicted `gone`, `exists` or `unwritable` because the writer refused to locate, write, add or remove it —
  the notice and the commit report's edit carry `detail`, the writer's reason, as `waiting` already did. An outcome the
  session decided alone (`overlap`, `changed`, `shifted`, a writer without the verb) has none. The affected cases now
  expect it: from the toy writers' own strings, and for Cascata's writer from an oracle that asks the writer itself on the
  same bytes. Sabotage: a set's refusal without its words (2 red); the commit report without them (3).
- **FIX-005 — a writer that contradicts itself throws** (open edge 4). `inside` says a path is inside a staged edit and
  `amend` then answers `{ inside: false }`: that is a writer bug, and a writer bug throws, as a range outside the bytes
  does; the stage rejects and the index is as it was. It used to fall through to ordinary staging. Sabotage: the old fall-
  through (1 red).
- **A re-indent counts as a change** (open edge 2, the owner's ruling A). `changed` stays strict: any byte of what the
  delete would cut, layout included. A colleague's reformat drops a pending delete loudly, and the user stages it again.
- **A delete restaged as a set goes last** (open edge 3, no change). It is a replacement at the same path, and the 0.5 rule
  holds: a restaged edit counts as staged last. Only an amend to a staged insert keeps its place, being the same insert.

**Tests removed, superseded by the rulings, and why:** "FR-002: bytes that do not open make every edit unwritable on
rebase" (FIX-001 replaces the behaviour it pinned) and "FR-010: … a comment a colleague adds above the entry is outside
the located bytes, so the delete proceeds and takes it too" (it pinned the defect FIX-002 fixes; the first FIX-002 case
is its inverse).

**Documents amended:** `docs/write-back.md` (the conflict list, waiting), `docs/glossary.md` (*Edit value*, *Waiting*),
`README.md` (status), the kernel's `contracts/public-api.md` (the editing types, all stale since this round), and a
pointer at the head of `specs/editing/spec.md`'s requirements.

**Still open from the report:** `EditValue` removed without an alias (Provenance has one user). One unrelated test
failed once in a full run and passed three times after (the slow real-disk tests `specs/HANDOFF.md` names).
