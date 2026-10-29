# Report: saveable index (specs/saveable-index/), implementer Sonnet

Tests 269 before, 287 after (18 new, all in `test/saveable-index.test.ts`; no existing test changed or removed). `npm test` green on the final tree, `grep '^ℹ fail'` reads 0. `grep -rn SABOTAGE src test` is empty and `src/session.ts` was compared with its pre-sabotage copy (`cmp`). No version bump. `docs/`, the kernel spec and the public-API contract are untouched (the contract lists `Session`; it needs `save`, `restore` and the three new types). Nothing pushed.

## Commits

- 4f9143d `docs(saveable-index): the round's spec`
- ec0c772 `feat(saveable-index): session.save() returns the index as plain data` (Part A)
- 69dd5c6 `feat(saveable-index): session.restore() stages a save again against its base, then rebases` (Part B)
- 4837507 `test(saveable-index): a restore keeps its own copy of the saved bytes`
- the shift-guard test commit, `test(saveable-index): the shift guard across a restore`
- this report

**Tests first was not witnessed red.** The new API does not exist before the code, so a test file against it fails to compile (`tsc`) and cannot run; I wrote each Part's tests, then the types and code, and the first run of each was green. The tests' expected values are derived by hand (the byte ranges of `x: 1⏎y: 2⏎` and of `walls.yaml` are counted in the file's header comment, the insert cases reuse insert-delete's counted fixtures). The sabotage table below is what stands in for "red first".

## What was built, per FR

- **FR-001** `session.save()`: synchronous, reads `staged`, returns plain data (`Uint8Array`, `Map` for values, strings, numbers). The base bytes and each `disk` are copied (`slice`), so writing into the save does not reach the session (tested, sabotaged). A structured clone of a save deep-equals it (tested).
- **FR-002** `SavedIndex` is `{ format: 1, sources: { location, base, bytes, edits: { op, path, value?, status, disk? }[] }[] }`, in staging order of sources and edits; `location` is the staging key (canonical); `value` and `disk` are absent, not `undefined`, when absent. No byte ranges. Types `SavedIndex` and `SavedEdit` in `src/index.ts`.
- **FR-003** `status` and `disk` are saved and put back (case 5).
- **FR-004** A waiting source is saved like any other (its `staging.base` and `staging.version` are the base, not the unreadable disk), and restores waiting when the disk still does not open, then rebases when one that opens arrives (tested end to end).
- **FR-005** `session.restore(saved): Promise<RestoreReport>`, its work inside `serialize`. An unknown `format` resolves a refusal and touches nothing (case 8).
- **FR-006** Per source, in order: not in the graph / external / unreadable / no writer (the reasons `stage` gives, now from one function `stageable` shared by both), already staged, saved bytes not hashing to `base`. Otherwise each edit goes through the **same `stageEdit`** (overlap, inside, amend, same, effective, perform: nothing duplicated) with a new optional parameter `against: { version, bytes }` naming the base to open and stage the source's *first* edit against; later edits find the staging that first one made. Then `status` and `disk` are put back on the staged edit with that path, and if the node's version is not `base` the one `rebase` runs onto the node's held bytes.
- **FR-007** An edit the writer refuses is `refused` with the stage's words; the source's other edits are restored (tested with Cascata's own refusal text as the oracle).
- **FR-008** `RestoreReport` and `SourceRestore` in `src/index.ts`; the rebase's notices arrive in the `Change` that `restore` returns through `report([])`, announced after the work is kept (a throwing listener rejects the call and undoes nothing: tested).
- **FR-009** A writer throw rolls everything back through the existing snapshot (case 12: a source restored before the throw is gone again; a pre-existing staged edit on a third source is untouched; nothing announced).
- **State.** Restore adds no state beyond `staged`. `Staging` objects it creates are the same shape `stage` creates; the snapshot already covers them. `notices` is cleared by `serialize` as for any piece of work. Confirmed by the case 12 sabotage below.
- **The shift guard crosses the gap** for free: `staging.doc` is the saved base's document, so a list that changed length while the page was closed conflicts the edit `shifted` (tested; not in the spec's twelve).

## Sabotage (each restored; `cmp` against the original afterwards; the new test file only, then the full suite green at the end)

| Claim | Sabotage | Red |
|---|---|---|
| save carries the base bytes (copied) | empty bytes | 17 (every restore test, FR-002, FR-003, FR-004 ...) |
| save copies the bytes | not copied (`slice` removed) | FR-001 "saved bytes are the save's own" |
| save carries `disk` | omitted | 2: FR-003, case 5 |
| save carries `status` | always `staged` | 2: FR-003, case 5 |
| save carries the base version | `"x"` | 16 |
| ruling 5, already staged | check removed | 1: case 7 |
| hash check | removed | 1: case 6 |
| rebase when the version differs | removed | 5: cases 2, 3, 4, FR-004, FR-008 |
| staged against the saved base | against the held version/bytes | 5: same five |
| the staging's version is the saved base | `node.version` | 1: FR-004 (waiting) |
| restore puts `status` back | removed | 1: case 5 |
| restore puts `disk` back | removed | 1: case 5 |
| `format` check | removed | 1: case 8 |
| sources in saved order | reversed | 3: FR-006, 6, 7 |
| edits in saved order | reversed | 4: case 1 (both), case 9, FR-007 |
| a source with no restorable edit is refused | reported `restored` | 1: FR-007 |
| rebase reads the node's bytes, not the saved ones | rebased onto the saved bytes | 5: same five |
| restore keeps its own copy of saved bytes | `slice` removed | 1: FR-006 copy test |
| restore keeps its own copy of `disk` | `slice` removed | 1: same |
| rollback | `restore(staged, before.staged)` removed | 1: case 12 |

Equivalent mutant found, not a gap: preferring `against.bytes` over the staging's own base in `stageEdit` turns nothing red, because they are the same bytes. Not sabotaged: the shift-guard test (it exercises unchanged `rebase` code through `staging.doc`; no line of mine to break), the `stageable` extraction (`stage`'s existing tests cover it, and all stayed green).

## Ambiguities, invented details, and things the spec got wrong (unsoftened)

1. **The shape of `RestoreReport` is mine.** The spec says "one entry per saved source: `restored` or `refused` with a reason, and per edit `restored` or `refused`", and nothing for a save refused whole. I added a report-level `outcome: "restored" | "refused"` and `reason` (used only for an unknown format, with `sources: []`). A report with every source refused is still `outcome: "restored"`. Per-edit entries carry `reason` only when refused.
2. **A refused whole save resolves, it does not throw.** "Refused whole" could be a rejection. I followed `stage`'s convention (refusals resolve; a writer bug throws). The check runs before `serialize`, so it is not queued behind other work and answers even on a closed session; a closed session with a valid `format` resolves `refused` with `the session is closed`... only as the initial value of the result, because `serialize` skips closed work: the report says `outcome: "refused"`, `reason: "the session is closed"`, untested.
3. **A source none of whose edits could be restored is `refused`** (`none of its edits could be restored`), though FR-006's list of refusals does not name it, and FR-007 says only that the other edits are restored. The smallest reading that keeps "restored" meaning "something is staged". Its per-edit entries are listed.
4. **Every `reason` string is mine**, pinned by the tests: `the saved bytes do not hash to the saved base version`; `<location> already has staged edits`; `none of its edits could be restored`; `a set needs a value`; `the saved index has format N, and only format 1 is known`. The graph / external / unreadable / no-writer reasons are `stage`'s, unchanged.
5. **The order of the source-level checks** is graph/writer, then already staged, then hash. The spec lists them in another order ("not a source, not claimed, already staged, hash"), which this matches, but a source that fails two (say tampered *and* staged) reports only the first.
6. **A source listed twice in one save** is refused the second time as `already has staged edits` (the first restore staged it). Spec silent. **Two edits with one path in one source** (a hand-made save; `save()` never makes it): the later replaces the earlier as `stage` does, and the report says both were restored.
7. **A `set` or `add` with no `value`** is refused per edit (`a set needs a value`). The type allows it (`value?`), as the spec's FR-002 writes it; `save()` never produces it.
8. **The saved `status` and `disk` are trusted.** A hand-made `overrides` on an edit that overrides nothing, or on an insert, is put back as written. The status is put back on the edit with the saved path *after* staging; an edit amended into another (impossible in a save `save()` produced) would be skipped silently.
9. **`location` in the report is the one in the save**, not the canonical key restore computed (`keyFor`). On the memory host they are equal; on the Node host a save made in one spelling and restored where the path canonicalizes differently would report the saved spelling. `restore` canonicalizes the location it is given, so a differently spelled `location` still finds the source.
10. **Source ids are not saved.** The spec's case 1 says `index()` equals the old session's. That holds because both sessions discovered their sources in the same order (`s1`, `s2`...). The id is the session's, not the save's; a restore into a session that discovered sources in another order gives other ids in `index()`. The save carries `location`, which is right, but case 1's claim is true only under that condition.
11. **`save()` copies the base bytes of every staged source on every call.** The studio saves after each editor transaction; a large file costs a copy per keystroke. Not copying would hand the embedder a view of the session's base. A `ponytail:` choice for safety, with the ceiling named here: return the reference and document "do not write into it" if it measures slow.
12. **`restore` compares `node.version` (the version the session holds) with `base`.** For an `undecodable` or `leaf` source with a writer that is the same; a node whose `bytes` are missing (a source not read) is refused `was not read`.
13. **Nothing decides a restore against a source whose newest version does not open**: it reuses the rebase's waiting path, so the notice is `waiting` and `index()` carries `waiting`, as for any waiting edit (tested via the picky writer).
14. **Case 12 is built on the key=value writer** (a `.conf` writer that throws on the value `BOOM`), not YAML as the other cases are, because wrapping Cascata's document breaks `shifted` (HANDOFF). The spec's cases are "on `a.yaml`"; I used YAML for all but this and the waiting tests.
15. **The spec's "Method and limits" says "the new state is `staged` only, already in the snapshot".** True; but `Staging.doc` (a cache, not state) is set to the *saved base's* document by restore, and the rebase replaces it with the new one. If a restore stops before the rebase (no rebase needed) `doc` stays the saved base's, which is the held base: correct.
16. **Groups are not in the save** (the spec says so); `format` is the guard.

## Wording I would want

**Glossary, "Index".** The staged edits of a session, in groups, with a position map per touched source from its preview back to its base. *(editing)* *The first slice (`specs/editing/`) builds the index without groups or a position map: one edit per path, per source.* *Since `specs/insert-delete/` an edit carries its operation (`set`, `add`, `remove`), and an edit inside a staged insertion amends it rather than joining the index.* **Since `specs/saveable-index/` it can be saved and restored:** `session.save()` returns it as plain data (per source, its base version and base bytes, and each edit's operation, path, value and status; no byte ranges), and `session.restore(saved)` stages the edits again against the saved base through the writer and rebases them onto the version the session holds, so an edit made before the page closed is carried over, overridden or dropped exactly as a rebase reports. Restoring never merges: a source that already has staged edits is refused.

**`docs/write-back.md`**, a line under "The lifecycle of an edit": *Save and restore* (2026-10-29, `specs/saveable-index/`): the index survives a reload as data the embedder stores; the saved base bytes are the one thing the disk can no longer supply, and the named upgrade (ask the host for a version's bytes) is parked.

**README / changelog.** A minor release, additions only: `Session.save`, `Session.restore`, `SavedIndex`, `SavedEdit`, `RestoreReport`, `SourceRestore`.

## Breaking changes

None. `Session` gains two members (a consumer that implements `Session` itself, rather than receiving one from `openSession`, stops compiling; no such consumer is known). `stageEdit` gained an optional parameter; `stage`'s behaviour and reasons are unchanged (all earlier tests pass untouched).
