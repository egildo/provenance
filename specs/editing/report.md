# Report: editing, first slice

Tests 98 before, 140 after, all green. `grep -rn SABOTAGE src test` empty. No version bump. `docs/`
and the kernel spec untouched; the public-API contract gained the editing surface (step 5).

## Commits

- 3391e3e `feat(editing): the Writer shape, Host.write, the Node host's atomic write` (FR-001-003)
- 523c910 `feat(editing): stage, index, unstage and preview` (FR-004-007)
- 76071f5 `feat(editing): rebase staged edits by path when a source changes` (FR-008)
- 4f5ab01 `feat(editing): commit, with the write sandbox and a report per edit and per source` (FR-009, FR-010)
- `test(editing): commit through the Node host; a throw while committing rolls the session back`
- this report, and `contracts/public-api.md`

**Red first, honestly.** Every test file was written before its code, and was red because the
methods did not exist (a compile error under `npm test`). After that, each step's tests passed on
the first run of the implementation. So the tests are not shown red by behaviour; the sabotage
below is what shows they can fail.

## Shape

- `Writer` is `{ claims, locate, write }`, as the spec has it. `path` is typed **`string`**, `value`
  is **`unknown`**. The spec says both are opaque to Provenance, but "a new edit at a path that
  already has one replaces it" needs paths to be comparable, and a string is what every path the
  design names (JSON Pointer, selector plus property, heading path, element id) is. Say so in the
  spec.
- `Session` gains `stage`, `index`, `unstage`, `preview`, `commit`. Names kept as proposed, with one
  caveat below. `preview` returns a Promise because its version is a SHA-256 (async in every realm).
- `Change.edits?: EditNotice[]`, with `outcome: "moved" | "overrides" | "conflicted"`. `CommitReport`
  has `sources: SourceCommit[]`; each has `outcome`, `reason?`, `version?`, `edits[]`.
- State: a per-source `Staging` (writer, base version, base bytes, edits, the version of the last
  preview analysed). It is in the rollback snapshot with `nodes` and the rest, deep-copied. The new
  holds (a preview's version while its edits are staged) are in `holds()`, so held-versions applies.
- A source's bytes are kept on its `Node` only while it has staged edits, so a rebase can read what
  a new version holds without a second read.

## Sabotage (backed up to `/tmp`, marked `SABOTAGE`, restored)

| Sabotage | Red |
|---|---|
| apply edits front to back | case 8 |
| stack edits at one path | case 7 |
| the staged preview not held | the preview-held test |
| the overlap check removed | the overlap test |
| rebase by the old range, not by path | case 3 (staged), and the read-pass rebase test |
| skip the changed-bytes comparison | case 4, and the sticky-overrides test |
| rebase silently (no override notice) | case 4 |
| rollback does not restore `staged` | the rolled-back-batch test, and the throw-while-committing test |
| a read pass's rebase skipped (`nodes.set` only) | the read-pass test |
| absent `writable` means everything | cases 9 and 13 |
| a commit does not rebase when the disk moved | the three "unabsorbed" commit cases |
| a commit does not re-read what it wrote | case 1 and FR-010 |
| the sandbox compares prefixes, not segments | case 13 (`/dd` under `/d`) |
| a commit does not clear what it wrote | cases 1, 2/12, 13 and the failure case |
| the Node host writes in place | the atomic-write test (the inode did not change) |

## Silent, contradictory or wrong, and what I invented

1. **`stage` is the glossary's `Stage` in another sense.** The glossary says **Stage**: *Not
   Provenance's*, the browser projection; and in the same entry that *edits* are "staged". The verb
   is the glossary's own word for what an edit is, so I kept `stage`, but a reader of
   `session.stage(...)` meets a method named after a term the glossary says Provenance does not
   own. The entry should say the verb is Provenance's.
2. **FR-008's rebase finds the range and keeps the replacement bytes; the glossary's *Rebase* says
   the edit asks the plug-in "to write its value there again".** These differ when style depends on
   neighbours (YAML quoting after a moved comment). I followed the spec: `locate` only. If the
   writer should re-write on the new bytes, FR-008 needs saying so.
3. **"Overrides" is sticky; the spec does not say.** Case 4 wants the commit report to say `overrode`
   after the change was absorbed and rebased, so a status that came from the rebase must survive
   until the commit. I made it survive later rebases that leave the value alone (the disk bytes
   noted stay the first override's); only staging the path again clears it. Without a rule the
   second rebase would compare against a base that already holds the colleague's value and call it
   unchanged.
4. **Commit's source outcomes: the spec has three, I added `conflicted`.** A commit that finds every
   edit's path gone (the disk moved, the session had not heard yet) has nothing to write, and
   neither `written`, `refused` nor `failed` is true. Its edits are listed as `conflicted`. For
   `refused` and `failed` the `edits` list is empty (nothing was resolved); the spec does not say.
5. **Reading the disk can fail at commit.** At commit I report `failed` with the host's reason and
   keep the edits; through the watcher the same situation (the file gone) drops them as
   `conflicted`. A transient read error should not drop an edit, a deletion should. The host
   cannot tell the two apart (`HostReadResult` has only a reason string), so the two paths disagree.
6. **A source that leaves the graph while edits are staged.** The spec is silent. I drop its edits
   as `conflicted` notices (a source gone from the graph has nowhere for them to land).
7. **`stage` refuses when the disk has moved past what the session last read** ("changed on disk
   since the session last read it"): the first staging reads the disk and compares its hash with
   the node's version. Invented: the alternative is to stage against bytes the session has not
   analysed. It costs one read at the first staging of a source.
8. **`preview` of a source with nothing staged is `undefined`.** The spec: "the source's base bytes
   with every staged edit spliced in", which for no edits would be the base, but the session keeps
   no bytes of unstaged sources.
9. **A preview is analysed.** FR-007 says a preview is "held like any version under
   `cache-by-handler-and-hash` while its edits are staged"; nothing says it is analysed. I analyse
   it when `preview()` is called (the handler's findings, cached by its version) and hold that
   version until the edits change. Otherwise "held" is vacuous. The findings are not exposed:
   there is no API that returns them yet.
10. **A writer that throws, or returns a range outside the bytes, is a programmer error and throws**
    (a `RangeError` for the range, like `byteOffsets`), rejecting the call and rolling back. The
    kernel rule names handlers only; it should name writers. An overlap, by contrast, is *refused*,
    because the spec says so.
11. **Overlap is not rechecked after a rebase moves ranges.** Two edits whose new ranges overlap
    would be spliced wrongly. Unreachable with a writer whose `locate` is consistent, which is the
    writer's duty; not enforced.
12. **Staging emits no `Change`.** The spec lists what `Change.edits` reports (moves, overrides,
    drops) and says nothing about stage, unstage or commit. A commit emits the ordinary change (the
    written sources as `changed`), with `edits` for any rebase it did.
13. **Commit is a rolled-back piece of work and a file write cannot be taken back.** If the
    handler throws on the text just written, the commit rejects and the session is restored with
    the edit still staged, while the file holds it. A second commit would find the disk differs
    from the base and report the edit as having `overrode` its own bytes (by reading the code; not
    run). The kernel's rule and FR-009's "not atomic across files" do not say what a commit that
    throws after writing should leave.
14. **`Host.write` and the memory host's `write` are one member.** The memory host already had a
    test helper `write(location, content): void` used by every test to change the disk. I made it
    the host's `write` (returns `Promise<{ok:true}>`), so it still serves both, and it notifies
    watchers, so a session's own commit is heard once by the watcher and found already held. Tests
    that ignore its return value are unchanged.
15. **The sandbox canonicalizes each root on every commit** and falls back to `paths.resolve` when
    the root does not exist. A root that is a symlink is judged by its target, as sources are.
    Case-insensitive file systems and Windows drive letters are not handled; the spec says
    "canonical locations with the host's `paths`" and nothing more.
16. **`unhandled()` (the unhandled-rejection helper) is now in `test/helpers.ts`**, duplicated from
    `test/throwing.test.ts`, which I left alone.
17. **Glossary entries the build does not yet match:** *Index* is "in groups, with a position map",
    and `index()` is a flat list; *Edit* may be a file operation; *Commit* says it empties the
    index "afterwards", per file here. None is wrong for the first slice, but the glossary does not
    say which parts are built.
18. **Leak.** A `Node` keeps its `bytes` after its edits are committed or dropped, until the next
    reload of that source. Small and bounded; not cleared.

## What should change in the documents (not edited)

- Glossary: *Stage* (finding 1), *Rebase* (2), *Conflicted* (a source gone from the graph, 6), and a
  line saying which of *Index*, *Edit*, *Commit* are built.
- `docs/write-back.md`: the lifecycle says rebase is "found again by its semantic address" and the
  preview rebuilt; it should say what an override's `disk` carries and that the status is kept (3).
- `specs/editing/spec.md`: FR-001 (`path` is a string), FR-007 (a preview is analysed), FR-009
  (the `conflicted` source outcome, the failure to read), and the cases' "Law" column should name
  which law a case tests, which several do not.
- `specs/source-graph-kernel/spec.md`, `broken-is-reported-not-thrown`: add writers (10), and say
  what a commit that throws after writing leaves (13).

## Round 2: a commit's writes are kept, rebase writes again, staging never refuses a moved disk

Tests 140 before, 141 after (the two tests that pinned the old behaviour were replaced, below).

1. **A commit's writes survive a throw.** `commitSource` records each key it has written; when the
   piece throws, after the rollback restores everything, those keys' edits are removed from the
   index. Sources not yet written stay staged, as before. Test: three sources, a handler that
   throws on the second one's written text; the first and second are on disk with their edits out
   of the index, the third is untouched and still staged, and a second commit writes only the
   third and reports nothing overrode. **Deliberately replaced:** my round-1 test "a handler that
   throws on the written text rejects the commit; the session is rolled back though the file is
   written" pinned the opposite.
2. **A rebase writes the value again.** On every move the writer's `write` is called on the new
   bytes for the edit's path and value, and its range and bytes are the edit's; `locate` still
   decides "gone". A `write` that refuses on the new bytes drops the edit as `conflicted`. Test: a
   writer that quotes a value when the previous line ends with a comma; the neighbour gains a comma
   on disk, the edit moves to 7-8 and is spelled `"3"`.
3. **Staging never refuses a moved disk.** The refusal and its read are gone; the base is the bytes
   of the version the session holds. To have those bytes, a `Node` now keeps `bytes` for every
   source a writer claims, for the life of the session (it was: only while edits were staged). That
   is a memory cost proportional to the writer-claimed sources, and it supersedes finding 18.
   **Deliberately replaced:** the round-1 test "a disk the session has not absorbed yet cannot be
   staged against" now asserts the opposite: the edit is staged at 6-7 against the old base, and
   the absorbed change moves it to 13-14.

**Sabotage** (backed up, marked, restored): keep the rollback restoring a written source's edits:
the commit-throws test, alone. Reuse the old replacement bytes on a rebase: the neighbour-spelling
test, alone. Reinstate the refusal: the moved-disk staging test, alone.

**Still wrong or silent.**
- The kernel rule says a throw after a write leaves the file committed with "the written version
  its base". The node of that file cannot be re-analysed (that is what threw), so it stays at the
  old version, with the old `bytes`, until the host reports the change. The session catches up
  through the host's change report; a host that does not report its own writes leaves it stale. The
  same holds for an earlier source of the same commit whose reload had succeeded: the rollback
  restores its old node too. No `Change` is emitted for those writes on that path. If "base"
  should be literal, the session needs a way to hold a version it could not analyse.
- A rebase whose edit keeps its range but whose re-written bytes differ (a neighbour changed
  spelling without moving anything) is silent: no `moved` notice, since nothing moved. FR-008 says
  "nothing silent".
- `contracts/public-api.md` still listed the moved-disk refusal; I removed that clause.
