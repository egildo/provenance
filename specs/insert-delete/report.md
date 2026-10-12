# Report: insert and delete (specs/insert-delete/), implementer Sonnet

Tests 174 before, 233 after (59 new, all in test/insert-delete.test.ts; none removed). `npm test` green on the final tree, and three more runs in a row. `grep -rn SABOTAGE src test` is empty. Cascata's patched `amend.js` was compared against the pre-sabotage copy and is clean. No version bump. `docs/`, the kernel spec and the public-API contract are untouched. The tree is clean apart from `.claude/settings.local.json`, untracked and never added. Nothing pushed.

## Commits (one per Part, then the handoff)

- e5e96ad Part A: the opened writer, `stage` takes an operation (FR-001 to FR-003). Cascata `^1.16.0` installed.
- 06ceb65 Part B: containers, `EditData`, `op` on `StagedEdit` (FR-004, FR-005).
- d2210cf Part C: insert and same-spot order (FR-006 to FR-008).
- 6108ca0 Part D: delete (FR-009, FR-010).
- a50b65e Part E: edits inside staged edits (FR-011, FR-012).
- 410038c Part F: the shift guard and the new reasons (FR-013, FR-014).
- 9b048af `specs/HANDOFF.md` addendum.

Part G (witnesses and sabotage) is the tests and the list below. Each Part's tests were written before its code; the Part C, D and E tests passed on the first run of the code. The sabotages below are what show they can fail.

## What was built, per FR

- **FR-001.** `Writer` is `{ claims, open }`. `WriterDocument` is `locate`, `write`, and optional `add`, `remove`, `inside`, `amend`, `shifted`, shaped as in Cascata 1.16. New exported types: `WriterOpenResult`, `WriterLocateResult`, `WriterWriteResult`, `AmendResult`, `EditOperation`. Cascata's writers fit by shape; `src/` still names Cascata nowhere.
- **FR-002.** `Staging` holds `doc`, the base opened once. Staging opens only when the source has no staging. A rebase opens the new version once and asks it for every edit. Bytes that do not open are refused at staging with the writer's reason. On a rebase every edit is conflicted `unwritable`.
- **FR-003.** Existing tests pass, changed only as listed below.
- **FR-004.** `EditData` is exported. A plain object is a compile error, and Cascata's writer throws `TypeError`, which rejects the call and leaves the index as it was.
- **FR-005.** `StagedEdit.op`. `value` is optional and absent for `remove`. A `Map` stays the same `Map` instance in `index()`.
- **FR-006, FR-007.** `stage(.., {op: "add"})` goes through the opened base's `add`.
  - A writer whose document has no `add` is refused by name: `the writer for ${key} cannot add: its document has no add`.
  - Otherwise the writer's refusal is the staging refusal, verbatim (tested against Cascata's own answers for an existing key, an absent parent and a scalar parent).
  - On rebase, the order is shift guard, then `add`. A refusal is `exists` if `locate(path)` finds the key on the new version, otherwise `gone`. A new document without `add` is `unwritable`. An insert has no `overrides`. `moved` and `respelled` notices work as for a set.
- **FR-008.** The empty-ranges-at-one-offset clause is gone from `overlaps`. `splice` breaks ties by staging order: the earlier-staged edit ends up first in the text. Witnessed in the preview, at commit and across a rebase, in both staging orders. Two inserts into `walls: {}` overlap and the second is refused. An empty insert strictly inside another edit's range is still refused, and one at its edge is accepted.
- **FR-009, FR-010.** `{op: "remove"}`. A writer document without `remove` is refused by name. On rebase: shift guard, then `locate` on the new version (not found: `gone`). Then compare the new located bytes with the base document's located bytes for the same path (different: `changed`). Then `remove` on the new version (refused: `unwritable`; answered: it moves). A delete never gets `overrides` status.
- **FR-011, FR-012.** The table is implemented in `stageEdit` through `inside`, `amend` and `perform`.
  - Edits inside a staged set or insert call `amend`, then are written again through `write` or `add` on the opened base. The amended edit keeps its place.
  - An insert at its own path: a set or add amends it wholesale (keeps its place); a remove unstages it.
  - A delete at its own path: a set or add becomes a set of the entry (goes last); a remove replaces it.
  - Inside a staged delete is refused with `the entry at ${path} is staged for removal`.
  - A writer with `inside` but no `amend` is refused by name.
  - A writer without `inside` treats nothing as inside. If the source has a staged add, the writer's refusal is decorated with a note naming the missing capability.
  - Removing the last key of a staged insert leaves a staged insert of an empty container (`  W3: {}⏎`).
- **FR-013, FR-014.** `staging.doc.shifted?.(path, newDoc)` is asked first, for every edit, on every rebase and commit-meets-moved-disk. `ConflictReason` is `gone | overlap | unwritable | exists | changed | shifted`, carried by notices and by the commit report (witnessed for each of the three new ones through both the watcher and the commit path).
- **FR-016.** All listed cases are covered, with hand-counted bytes against Cascata's real YAML and JSON writers. The toy writers cover missing capabilities and shifted-call arguments.
  - **walls.yaml.** It gains W3 whole (22 bytes at 51), loses W1 (bytes 7-29), and does both in one commit (51 bytes again).
  - **YAML offsets.** The set of the container `/walls/W2` is at 39-50, and the shifted list file is 61 bytes with the height at 57-60.
  - **Real disk.** One real-disk Node-host test closes its session and removes its directory through `closing` and `scratch`. I sabotaged one of its assertions: it failed in about 0.2 s and did not hang.
- **FR-018.** L1 holds: an unstaged insert, or an insert removed again, commits `{sources: []}` and writes nothing. L3 holds: whole-file equality shows only the edit's bytes moved, for insert, delete and container set.

## Open counts, measured (counting writer; never timed)

- Staging 3 edits, one of them a restage, on one source: 1 open.
- After a rebase of 2 edits: 2 opens in total (1 for the base, 1 for the new version).
- Stage 2, then a commit that meets a moved disk: 2 opens.
- Stage 1, then a commit with an unmoved disk: 1 open.

## Sabotage (backups in /tmp/prov-backup; each restored; `SABOTAGE` grep empty)

| Part | Sabotage | Red |
|---|---|---|
| A | stage always reopens | 3: staging-once, rebase-once, commit |
| A | rebase opens per edit | 2: rebase-once, commit |
| A | unopenable-bytes conflict reported `gone` | 1: unopenable rebase |
| A | staging refusal reason replaced | 1: unopenable staging |
| B | `index()` copies the `Map`, and `op` hardcoded to "set" | 1 (identity test). The `op` half turned nothing red: only `set` existed yet, so that sabotage is vacuous in this Part. |
| B | array value stringified before the writer | 1: JSON sequence test |
| C | old same-offset clause restored in `overlaps` | 2: same-spot tests |
| C | tie-break reversed | 2: same-spot, preview and commit |
| C | `exists` always `gone` | 2 |
| C | `gone` always `exists` | 2 |
| C | missing-`add` reported `gone` | 1 |
| D | `changed` compares the new bytes with themselves | 3 |
| D | `changed` reported as `gone` | 2 |
| D | `e.op !== "set" \|\|` guard in the `same` computation removed | 1: the colleague's-comment test. I added the assertion `status: "staged"` after seeing it first turn nothing red. |
| D | `value: e.value` unconditionally in `index()` | 1 |
| D | remove-unwritable reported `gone` | 1 |
| E | `within` ignored | 5 |
| E | amended value ignored (re-write the old one) | 3 |
| E | amended edit goes last | 1: keeps-its-place test |
| E | remove of an insert does not unstage | 1 |
| E | `staged for removal` branch disabled | 1 |
| E | remove-then-set conversion disabled | 1 |
| E | Cascata's prefix test broken (`startsWith(within)`), in `node_modules`, copied and restored | 1: the W3 vs W30 "beside" test |
| F | shift guard always false | 5 |
| F | guard compares the base with itself | 4 |
| F | guard always true | 49. It also proves the not-shifted case is guarded. |
| rollback | snapshot omits `doc` | **nothing red.** `stageEdit` reopens from `base` when `doc` is missing, so `doc` is a cache. |
| rollback | snapshot's `doc` is a getter onto the live (mutated) staging | 1: the rollback test |

Not sabotaged, and untested: amend returning `inside: false` after `inside` said true (falls through to normal staging; invented).

## Existing tests changed, and why

- **All 89 `session.stage(location, path, value)` calls** became `stage(location, { op: "set", path, value })` (70 in editing.test.ts, 13 in joining.test.ts, 5 in real-disk.test.ts, 1 in node-host.test.ts). Mechanical; no assertion touched.
- **Old-shape writers.** `test/helpers.ts` gains `opened(oneShot)`, `keyValueShot` (the old object) and `keyValue = opened(keyValueShot)`.
  - Seven writers in editing.test.ts are wrapped in `opened({...})`: overlapping, wild, throwing-write, throwing-locate, the two `quoting` writers, `folding` and `refusing`.
  - Their `keyValue.locate/write` became `keyValueShot.*`.
  - test/writer.test.ts now calls `keyValueShot.*`. It tests the one-shot object, not the opened one.
  - joining.test.ts's "wrapped in an unannotated arrow function" writer now wraps `open`, `locate` and `write` of the document, still with unannotated `value`.
- **index() deepEquals.** Four now include `op: "set"` (editing.test.ts, cases 3, 4, 5 and 7), because FR-005 added the field.
- **Title only.** The test "a value is a scalar: an object is a compile error, and the scalars compile" is now "a value is EditData: a plain object is a compile error...". The `@ts-expect-error` comment text changed with it. The test body is unchanged.
- **joining.test.ts FR-005 (this is neither a stage call nor a writer shape).** The test pinned `editTarget`'s exact result. Cascata 1.16 adds `diagnostics: []` to it, so the expected value gained `diagnostics: []`. It was red until then, from the upgrade alone.
- **boundary.test.ts.** Only the manifest regex, now `^\^1\.16\.`.
- **Round-internal change.** My own Part D test "an edit over a staged delete's range is an overlap" was rewritten in Part E (a delete over a staged set's range, because the other direction is now "staged for removal"). The test is mine, from the previous commit.

## Where the spec, glossary, write-back.md and Cascata's verbs were silent, contradictory or wrong, and what I invented

1. **FR-007 cannot be implemented as written.** "Parent gone → `gone`; any other refusal → `unwritable`" needs Provenance to tell why a writer refused. A refusal is a string, paths are opaque (ruling 8), and Provenance has no way to name the parent.
   - **What I did.** After a refused `add`, I ask the new version whether the key is there. Found: `exists`. Not found: `gone`. This covers an absent parent, a parent that became a scalar, depth and size limits, and a shared-edit refusal alike. A scalar parent is therefore `gone` (pinned by a test with that title). `unwritable` for an insert happens only when the new document lacks `add` or the bytes do not open.
   - **Misclassification.** For a sequence index insert (`/tags/1`), a writer that refuses for an unrelated reason while an item exists at that index would be called `exists` wrongly.
   - **Fix.** A structured refusal code from the writers (Cascata already has `edit-target-exists`, `edit-parent-scalar` and others and flattens them to a message), in the Writer shape.
2. **`changed` (FR-010) compares what `locate` returns: the entry's value bytes.** Two consequences, both pinned by tests.
   - A colleague's comment added directly above the entry is invisible to the comparison, and `remove` takes the comment away with the entry. That is a colleague's work overwritten, contradicting ruling 5's principle.
   - A re-indented multi-line entry counts as changed. A single-key entry does not, because `locate` excludes the leading indent.
   - **Better comparison.** Compare the bytes `remove` itself would cut in the base document with those in the new one, since that range includes the attached comments. The spec said to use the set's comparison, so I did.
3. **Lost writer text.** `EditNotice` and the commit report carry the reason code, not the writer's words. A YAML file a colleague saved half-typed (does not parse) now drops every staged edit as `unwritable`. Before, a failing `locate` called it `gone`. FR-002 changed the label as well as the loss. Worth deciding whether a notice should carry the writer's text, and whether an unparseable file should drop edits at all.
4. **The table's "set | p = q: replaces" is silent on `add`.**
   - An `add` at a path that has a staged set goes to the writer, which refuses an existing key, in the writer's words. I read "replaces" as set and remove.
   - A set or add on a staged delete becomes a set and goes last (staging order), while an amend of an insert keeps its place. "Keeps its place" appears only for amends, so the difference is mine.
5. **FR-012 is ambiguous about half-capable documents.**
   - I decide "inside" with `inside` alone.
   - `inside` without `amend` is refused by name.
   - `amend` without `inside` is never consulted.
   - The decorated refusal (naming the missing capability) is added only when `inside` is absent and the source has a staged add, and its wording is mine.
6. **If the writer says `inside` and then `amend` answers `inside: false`**, I fall through to normal staging (invented, untested).
7. **FR-003 undercounts what had to change.** Index deepEquals (FR-005), `writer.test.ts`, a test title and the Cascata `editTarget` drift all forced edits beyond "stage calls and old-shape writers".
8. **`EditValue` no longer exists.** FR-004 says it "becomes `EditData`"; I removed `EditValue` (Cascata's `EditValue` is still the scalar). A kept alias would have lied. Anyone importing `EditValue` from Provenance breaks.
9. **Cascata 1.16's `shifted` throws `TypeError` for a `newer` it did not open.** The session passes the writer's own document object. A wrapper that forwards `shifted` with its own wrapped document would throw. This is in the handoff. The joining wrapper simply leaves `shifted` off.
10. **The rollback snapshot.** The brief said to add the opened document to the snapshot and restore. It is in (spread by reference, with a comment). But as sabotage showed, `doc` is a cache, and leaving it out is invisible. Only a doc from the wrong version is a bug.
11. **Staged remove then restaged as a set** loses its remove's place in order. Staged add then add at the same path (Part C, before E) briefly "replaced and went last"; Part E changed it to "amended in place". The C tests do not pin restage order for adds, deliberately.
12. **No structural way to tell a writer that a staged insert exists.** `perform` and `restage` write the amended insert against the base, so the writer never sees it. This is by design, but it means `inside`-aware writers must be pure over paths only.

## What should change in documents (not edited)

- **docs/write-back.md:90.** "Every conflict says which: gone, overlap, or unwritable" needs `exists`, `changed` and `shifted`. The lifecycle step 3 outcome list likewise.
- **docs/glossary.md.**
  - *Edit value* is stale: now `EditData`, containers included.
  - *Conflicted* opens with only the gone and overlap cases before it lists the new reasons.
  - *Index*: the first slice's "without groups" line is fine, but add that `value` is optional.
- **specs/editing/spec.md.** FR-001 (old `locate/write` shape), FR-004 (the three-argument `stage`) and FR-005 (the `StagedEdit` fields).
- **specs/source-graph-kernel/contracts/public-api.md** (kernel dir, so not mine). Lines 37 and 93 to 109 (`stage`, `Writer`, `EditValue`, `StagedEdit`) and line 130 (`ConflictReason`) are all stale.
- **README.md status paragraph.** "The first slice sets values only" is now untrue.
- **CHANGELOG.** No 0.6.0 entry yet (not mine to bump).
- **Glossary and write-back.md on `exists` and `gone`.** Both describe `gone` as "the parent is gone", but in practice it also covers a parent that has become a scalar or a refusal for depth or size limits (point 1 above).

## HANDOFF

`specs/HANDOFF.md` has a new addendum with only what the specs, report and docs do not hold: the `stageEdit` decision order, `doc` as a cache, why not to match writer text, the `shifted` wrapper trap, how to sabotage Cascata safely, the test layout and helpers, and the closed and still-open edges.

---

## Coordinator's verification (2026-10-12)

- `npm test`: 233 tests, 233 pass, 0 fail; `grep -rn SABOTAGE src test` empty; the installed
  `@egildo/cascata` 1.16.0 `dist/` is byte-identical to the published tarball (the implementer had sabotaged
  a copy inside `node_modules`).
- An independent probe outside the suite, against Cascata's real YAML writer on `walls.yaml`: insert `W3`
  whole, amend its height inside the staged insert, delete `W2`, an edit inside the staged delete refused,
  a set through a list; then a colleague adds a comment line on top, changes `W2`'s height and inserts a
  list item at the top. Outcome: the insert moved (to the end of the longer file), the delete conflicted
  `changed`, the list set conflicted `shifted`, the preview keeps the colleague's comment and `3.6`.
- Findings 1 (refusals need codes) and 2 (`changed` misses attached comments) are taken up as fixes;
  finding 3 (a half-saved file drops every staged edit) goes to the owner.
