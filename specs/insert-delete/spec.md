# Feature Specification: Insert and Delete — the opened writer, containers, and two new intents

**Feature Branch**: `insert-delete` (committed on `main`)

**Created**: 2026-10-12

**Status**: Approved by the owner, 2026-10-12 (implementer: Sonnet)

**Input**: Cascata 1.15 ("the opened document": a document parsed once answers many `locate`s and edits
against the bytes as opened; `add` and `remove`; containers written; Cascata's `SPEC.md` Article IX and
`specs/025-open-insert-delete/`) and Cascata 1.16 (`shifted` and `amend`, below; Cascata's `specs/026-shift-and-amend/`). The two intents
[`docs/write-back.md`](../../docs/write-back.md) parks — *insert this child*, *delete this node* —
"back with the first consumer that adds a wall". Terms are [the glossary's](../../docs/glossary.md). The
owner ruled the shape on 2026-10-12, one decision at a time:

1. **One round**: speed, then containers, then insert, then delete, each committed green.
2. **A writer is `claims` and `open`.** `open(bytes)` answers an opened document with `locate`, `write`
   and, optionally, `add` and `remove`; `locate` and `write` leave the writer itself. A writer whose
   documents lack `add` or `remove` refuses those intents by name at staging. Cascata's writers fit by
   shape (they keep their one-shot verbs beside `open`; a superset fits).
3. **One staging verb taking an operation**, JSON Patch's operation object with Cascata's verb names:
   `stage(location, { op: "set" | "add" | "remove", path, value? })`. It replaces today's
   `stage(location, path, value)`.
4. **A rebased insert whose key a colleague has meanwhile added is conflicted**, new reason `exists`;
   the colleague's entry is kept, even when it equals the staged one.
5. **A rebased delete whose entry a colleague has changed is conflicted**, new reason `changed`; the
   colleague's work is kept. With ruling 4 this is one principle: **a set follows last-saver-wins (L5);
   an insert or a delete never overwrites a colleague's work on the same entry.** A delete whose entry
   is already gone is conflicted `gone`, as a set's is.
6. **An edit inside a staged insertion amends it.** A set, add or remove whose path lies inside a staged
   insert changes that insert's value; removing the inserted entry itself unstages it
   (`docs/design-synthesis.md` already says so for positions). Two consequences, written in by the
   coordinator: an edit inside a staged delete is refused; two inserts at the same spot are kept in
   staging order (Cascata guarantees appends to one non-empty container compose), except two inserts
   into one *empty* container, which overlap and are refused at staging — stage the container whole.
7. **The shift guard.** A staged edit whose path runs through a list that changed length since the base
   is conflicted on rebase, new reason `shifted`. Never edits the wrong item; over-cautious by choice.
   Finding the item again by content (GNU `patch`'s offset by context) is the named upgrade.
8. **The writer amends, not Provenance.** Whether a path lies inside another, and what an operation does
   below it, is the path language's, so the writer's opened document answers it (`amend`); Provenance's
   paths stay opaque, and each format keeps one reader of its paths. A writer without `amend` makes an edit
   inside a staged edit refused by name.

**Ships as 0.6.0.** Do not bump the version. The coordinator amends `docs/write-back.md` and
`docs/glossary.md` in the same commit as this file (Part F); **do not edit `docs/`**; report every place
the code disagrees with them.

**Cascata 1.16 is the dev dependency** (`^1.16.0`): this round's tests use its writers. Update the
manifest assertion in `test/boundary.test.ts` and nothing else of it; `src/` still names Cascata nowhere.

---

## Part A — The opened writer (speed)

- **FR-001** `Writer` is `{ claims(location): boolean; open(bytes): { ok: true; document: WriterDocument }
  | { ok: false; reason } }`. `WriterDocument` is `{ locate(path); write(path, value); add?(path, value);
  remove?(path); shifted?(path, newer: WriterDocument): boolean; amend?(staged: { path; value },
  operation: { op; path; value? }): { inside: false } | { inside: true; ok: true; value } | { inside: true;
  ok: false; reason }; inside?(path, within): boolean }` (Cascata 1.16's shapes), with the result shapes `locate` and
  `write` have today; `add` and `remove` answer what `write` answers. A writer is still pure.
- **FR-002** **One opening per version.** Staging opens the base once per source and keeps the opened
  document beside the base bytes (`Staging`) for as long as edits are staged; a rebase opens the new
  version once and asks it for every edit. A source whose bytes do not open is `unwritable` for every
  edit (rebase) or refused (staging), with the writer's reason. Witnessed by **counting `open` calls**
  with a counting writer, never by timing: staging N edits on one source opens it once; a rebase of N
  edits opens the new version once.
- **FR-003** Everything FR-004 to FR-010 of `specs/editing/spec.md` and the 0.5 fixes say about `set`
  holds unchanged through the new shape. The existing editing tests pass, changed only where they call
  the old `stage(location, path, value)` or build a writer of the old shape; name each such change in
  the report.

## Part B — Containers

- **FR-004** `EditValue` becomes `EditData = string | number | bigint | boolean | null | readonly
  EditData[] | ReadonlyMap<string, EditData>`, the same union under the same name as Cascata's, so a
  writer fits by shape. A set may carry a container. A plain object is not `EditData` (Cascata throws
  for one; the session does not catch a writer's programmer-error throw, as today).
- **FR-005** `StagedEdit` gains `op` and carries `value` only for `set` and `add`. `index()` returns
  values as staged; a `Map` stays a `Map`.

## Part C — Insert

- **FR-006** `stage(location, { op: "add", path, value })` stages an insert through the opened base's
  `add`. Refused at staging: a writer whose document has no `add` (reason names it); the writer's own
  refusal (`exists`, an absent parent, a scalar parent: the writer's reason, verbatim).
- **FR-007** **Rebase of an insert** (ruling 4), on the new version's opened document: the shift guard
  first (FR-013); then `add` again. The writer refuses because the key exists → conflicted `exists`; the
  parent is gone → `gone`; any other refusal → `unwritable`; answered → the edit moves (or stays) as a set
  does, with `moved`/`respelled` notices. An insert has no `overrides`: there is no disk value it
  replaces.
- **FR-008** **Same spot.** Two staged empty-ranged edits at one offset no longer count as overlapping
  (today's `overlaps` refuses them). They are spliced in **staging order** (the earlier-staged first in
  the text), in the preview and at commit; a restaged edit counts as staged last, as today. Any other
  overlap is refused at staging and conflicted `overlap` on rebase, as today.

## Part D — Delete

- **FR-009** `stage(location, { op: "remove", path })` stages a delete through the opened base's
  `remove`. Refused at staging: a writer whose document has no `remove`; the writer's own refusal,
  verbatim.
- **FR-010** **Rebase of a delete** (ruling 5): the shift guard first (FR-013); then `locate` the path on
  the new version. Not found → conflicted `gone`. Found, and the bytes of the located entry differ from
  the bytes of the same path's located entry in the edit's base → conflicted `changed` (the comparison a
  set uses to decide `overrides`). Otherwise `remove` on the new version; refused → `unwritable`;
  answered → moves as a set does.

## Part E — Edits inside staged edits

- **FR-011** **The table** (ruling 6). A new operation at path *p* on a source with staged edits, where
  *q* is a staged edit's path:

  | Staged at *q* | New at *p* = *q* | New at *p* inside *q* |
  |---|---|---|
  | set | replaces (as today) | refused if *q*'s staged value is a scalar; amends *q*'s value if a container |
  | add | `set` or `add`: amends the insert's value wholesale; `remove`: unstages the insert | amends the insert's value at the sub-path (`set`, `add`, `remove` applied to the staged `EditData`, with Cascata's meanings: `add` refuses an existing key) |
  | remove | `add` or `set`: becomes a `set` of the entry (the entry exists in the base); `remove`: replaces | refused: the entry is staged for removal |

  An amended edit is staged again through the writer (`add` or `set` on the opened base with the new
  value), so its bytes are the writer's, never the session's; it keeps its place in staging order.
  "Inside" is the writer's path language: for a JSON Pointer, *p* starts with *q* followed by `/`. The
  session knows no format: the prefix test is FR-012's.
- **FR-012** **Who reads into a path** (ruling 8). For each staged edit *q* on the source, the session
  asks the opened base's `inside(p, q.path)`; where it is true, FR-011's "inside *q*" row applies, and an
  amend is `amend({ path: q.path, value: q.value }, newOperation)`, whose refusal is the staging refusal,
  verbatim. Equality of paths is string equality, as today. A writer document without `inside` and `amend`
  cannot say what lies inside what, so nothing is treated as inside: an edit is staged as today, and the
  overlap check or the writer's own refusal (a path not in the base) stops one that lands in a staged edit.
  Its refusal reason then names the missing capability when the source has a staged add.

## Part F — The shift guard, and the docs

- **FR-013** **The shift guard** (ruling 7). On rebase, before anything else, a staged edit whose writer
  document has `shifted` asks the **base** document `shifted(path, newer)`: true means some list along the
  path has a different length in `newer` → conflicted `shifted`. Without `shifted` there is no guard (a
  CSS path has no list indexes). Cascata 1.16's opened documents answer it for JSON Pointers: every
  index step whose parent is a sequence in either version, `-` excepted.
- **FR-014** `ConflictReason` gains `exists`, `changed` and `shifted`. `EditNotice`, `SourceCommit.edits`
  and the commit report carry them as they carry today's three.
- **FR-015** **The docs** (coordinator, in this commit): `docs/write-back.md` loses the "parked" on two
  intents and gains the principle of rulings 4 and 5, the amend table in brief, and the shift guard;
  `docs/glossary.md`'s *Conflicted*, *Rebase* and *Index* entries are amended; the editing spec's "not in
  this milestone" gains a pointer here.

## Part G — Witnesses

- **FR-016** **Cases before code, hand-counted bytes**, against Cascata's real YAML and JSON writers
  where a format matters and the test writer where it does not. At least: write-back.md's `walls.yaml`
  gaining `W3` whole and losing `W1`; preview and commit of each; the rebase cases — insert carries over
  after a comment added above; insert `exists` (different and identical); insert `gone`; delete carries
  over; delete `gone`; delete `changed`; set, insert and delete `shifted` after an item is added at the top
  of a list; a set on `/walls/W1/height` *not* shifted by a list elsewhere; two appends at one spot in
  staging order (and the reverse staging order giving the reverse text); two inserts into an empty
  container refused; every row of FR-011's table; an insert into a writer without `add` refused by name;
  open counts (FR-002).
- **FR-017** **Sabotage** (`specs/HANDOFF.md`'s method): one open per version; the same-spot rule and its
  order; each new reason; the amend paths (break the prefix test; break apply-to-value); the
  shift guard (always false); the delete's `changed` comparison (compare nothing). A sabotage that turns
  nothing red is a finding.
- **FR-018** The laws L1 to L5 still hold for a set; for insert and delete, L1 (no edit, nothing written)
  and L3 (only the edit's bytes move) are witnessed on the cases above.

---

## Ambiguities the implementer should expect

- **An insert's staged value after amending to empty** (`remove` of the last key inside a staged insert):
  it is a staged insert of an empty container. Stage it so.
- **`changed` compares located bytes.** A colleague's change that only re-indents the entry counts as a
  change. Say so in the report if a case makes that look wrong.
- **Commit order of same-spot inserts** must match the preview's. Witness both.
- **The rollback snapshot** (`specs/HANDOFF.md`): the opened document now lives in `Staging`; it is
  immutable, so copying the reference is enough — but say so in the snapshot code, and add any new piece
  of state to both the snapshot and the restore.
- **Commit per Part** (A to F), `npm test` green, by explicit path; never push; no version bump.
