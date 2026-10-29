# Report: atomic commit (specs/atomic-commit/), implementer Sonnet

Tests 243 before, 262 after (19 new, all in test/atomic-commit.test.ts; none removed; 14 existing tests edited, listed below). `npm test` green on the final tree, `grep '^ℹ fail'` reads 0. `grep -rn SABOTAGE src test` is empty and `src/session.ts` was compared with its pre-sabotage copy. No version bump. `docs/`, the kernel spec and the public-API contract are untouched (the contract lists `CommitReport`; it needs the new fields). Nothing pushed. The tree is clean.

## Commits

- f346f4c `docs(atomic-commit): the round's spec`
- 8f0585f `feat(atomic-commit): a commit lands every staged source, or none` (src, the new test file, the edited existing tests)
- 351cd32 `test(atomic-commit): a throw while putting back keeps the put-back sources staged`

Tests were written first and run red (17 of the 18 then written failing on the old code; I did not record which one passed, and the claim it should have been red is not witnessed). Code followed. One implementation commit rather than per Part: the new report type makes the old and new tests incompatible in `tsc`, so no smaller step is green.

## What was built, per FR

- **FR-001 Prepare.** `commitSource` is split. `prepare(key, staging)` does today's checks and rebase (sandbox, host `write` present, read the disk, rebase when the version is not the base, the waiting check) and builds the bytes. It writes nothing. It returns either a `Ready` source (bytes, the disk's bytes, the version to write, the edit list) or the report entry of a source that is a cause. Rebase notices stay in `notices` whatever follows (witnessed: an aborted commit announces `moved` for a and `conflicted` for b, and a's edit stays staged at its moved range, base = the disk version).
- **FR-002.** `commitSources(entries, changed)` prepares every entry; if any is a cause, nothing is written, and every edit not dropped stays staged on the version `rebase` moved it to (a retry after unstaging b lands a on the rebased version; tested).
- **FR-003.** Otherwise every `Ready` is written in staging order with the host's own `write`; the disk's bytes read in prepare are kept.
- **FR-004 Undo.** If a write fails, the sources written so far are put back newest first: read the disk, compare its hash with the version this commit wrote (ruling 6), and only then write the remembered bytes. Failures: the read fails, the disk differs, or the put-back write fails: that source is `unrestored` with its reason.
- **FR-005.** Written (and `unrestored`) sources leave the index and get their new node; a put-back source keeps its edits and its old node (its freshly analysed node is discarded).
- **FR-006.** `Host` unchanged; `src/node.ts` untouched.
- **FR-007.** `CommitReport.outcome: "committed" | "aborted"`; an empty index is `committed` with no sources.
- **FR-008.** A cause keeps its own outcome; every other source is `aborted` with `reason` = `the commit was aborted by <location of the first cause>`.
- **FR-009.** `unrestored`, with `reason`, `version` (what this commit wrote) and `edits` as `written`/`overrode`; its edits leave the index.
- **FR-010.** `conflicted` means at least one edit was dropped; `edits` lists the dropped ones only.
- **FR-011.** An aborted commit returns. `serialize` keeps the work and announces the notices.
- **FR-012.** A throw keeps today's behaviour; see "FR-012: the question" below.
- **FR-013.** No new session state. The two things added live in locals of `commitSources`. The snapshot is unchanged. `writtenKeys` (existing) is now also *removed from* when a source is put back, so a throw after a put-back does not drop that source's edits (witnessed).
- **Groups (ruling 4).** `commitSources` takes a list of `[key, staging]`; `commit()` passes `[...staged]`.
- **ponytail** comment in the put-back names the window between ruling 6's read and the write.

## Sabotage (each restored; `src/session.ts` compared with the original afterwards)

| Claim | Sabotage | Red |
|---|---|---|
| a partial drop aborts (ruling 2, FR-010) | `dropped.length > 0 \|\|` removed | 2: case 9, "fix 2 ... commit meets the moved disk" |
| a cause stops all writes | write phase always entered | 6: cases 2, 3, 4, 13, sandbox, read-failure, notices test |
| undo exists | undo never entered | 6: cases 6, 7, 8, 8-read, 10, 11 (Node) |
| undo is newest first | `.reverse()` removed | 1: case 10 |
| ruling 6 check | hash comparison forced false | 1: case 7 |
| put-back writes the old bytes | writes the new bytes back | 4: 6, 8, 10, 11 |
| a failed put-back is `unrestored` | failure ignored | 1: case 8 |
| a put-back source keeps its edits | final loop deletes staging for all written | 3: 6, 10, 11 |
| `aborted` names the cause | names itself | 6 |
| report `outcome` | always `committed` | 17 |
| write order is staging order | reversed | 9 |
| analysis of a written file before the next write | `load` moved out of the write loop | 4: incl. the existing "a handler that throws on the written text ..." |
| `unrestored` lists its edits | edits empty | 2: cases 7, 8 |
| prepare rebases | rebase skipped | 17 |
| put-back removes the key from `writtenKeys` | removal dropped | 4 (first sabotage syntax-broke 16 files and was redone), incl. the new throw-while-undoing test |
| a read failure in prepare is `failed` | reported `refused` | 1 |

Not sabotaged: the sandbox, `refused` for a host without `write` and the waiting check inside `prepare` (unchanged code; existing tests cover them through the new path). Every claim above that was red had at least one *new* test red except the analysis-order sabotage, which the existing test catches.

## Existing tests changed, and why

By design (a write after a partially dropped or failed source no longer happens):

1. editing "case 13: the sandbox is per source, judged on whole path segments": `/d/w.conf` is now `aborted` (not `written`), `writes` is `[]`, the index keeps all three edits.
2. editing "a failure on one source does not stop the others; the report says what landed": renamed "a failure on one source stops the commit: ..."; `/w.conf` fails first, `/v.conf` is `aborted`, only `/w.conf` is attempted, both edits stay.
3. editing "fix 2: the same, when only the commit meets the moved disk": one dropped (overlap) edit now aborts: outcome `conflicted` listing only `b`, the file stays `BANG`, `a` stays staged.

Report shape only (`outcome` added to the expected report, FR-007; `aborted` where the one source is a cause): editing "case 1 ...", "case 2 and 12", "case 6: a conflicted edit is never written", "case 6, unabsorbed", "case 9: with no writable root", "case 11: a host that fails the write", "round 2: the same, when only the commit meets the moved disk"; insert-delete "FR-007 ... exists" (two), "FR-010 ... changed" (two), "FR-011, staged insert, same path: removing ...", "FR-013 ... shifted" (two); joining "case 2 ... 51 bytes", "case 6: a colleague deletes W2", "FR-005 ... refused as inherited"; waiting-and-codes "FIX-001 ... refused".

Left alone and still green, which is a finding in itself: editing "a handler that throws on the written text rejects the commit, and the file stays committed". It asserts that a source after the throwing one is never written. With all writes before any analysis it went red. I kept it green by analysing each file (`load`) right after its write, before the next write, and keeping the node only if the commit goes on. That keeps its meaning but is the half-applied commit ruling 1 forbids; see the question below.

## FR-012: the question (reported, not decided)

Should the FR-004 undo also run on a throw? What can throw now:

- in **prepare** (a writer's `locate`/`write`/`open` bug): nothing is written yet. Strictly better than today; tested (a writer throwing for the second source leaves the first untouched).
- in the **write phase**: the host's `write` rejecting (a host bug; hosts return `{ok:false}`), or a **handler throwing on the new text** in `load`. The second is realistic and leaves files before it written and those after it not written, i.e. a half-applied commit; tested as today's behaviour.

A cheaper fix than undo-on-throw for the realistic case: analyse the spliced bytes in prepare (as `preview` already does), so a handler that cannot analyse the new text throws before anything is written. Undo-on-throw would additionally cover host bugs, but needs the undo inside the `catch` of `serialize`, with an undo error never masking the original. I did neither.

## Ambiguities, invented details, and things the spec got wrong (unsoftened)

1. **Case 11 cannot be built as written.** "Forced by a read-only file": the Node host writes a temporary file and renames it over the target, and a rename ignores the target's mode, so a read-only `b.conf` is replaced without complaint. I made the *directory* of `b.conf` read-only (0o555), so the temporary file cannot be created. The test is skipped when run as root and restores the mode in `finally`. The spec's phrase is wrong for this host, and a read-only file is a case the Node host *does* write.
2. **Prepare runs on every source even after a cause is found.** The spec says "if any source met ruling 2 during prepare, nothing is written" but not whether to stop at the first. I did not stop: every source is rebased and every cause reported. Consequence: sources after the first cause have been rebased (staging mutated, notices kept) though nothing is written; this is what FR-001 says about notices, and the retry is cheaper.
3. **The wording of every `reason` is mine**: `the commit was aborted by <location>` (location, not the source id, because `refused` reasons already speak in locations); `<location> was saved by someone else after this commit wrote it; left as it is`; `putting <location> back failed: <host's reason>`; `putting <location> back failed: could not read it: <host's reason>`. Tests pin them.
4. **`reason` on `aborted` names only the first cause** when there are several; each cause still carries its own outcome.
5. **`edits` is `[]` on `aborted`, `refused` and `failed`**, as it is today for the last two. `conflicted` lists the dropped edits only, not the surviving ones.
6. **`unrestored.version` is the version this commit wrote, even when the disk now holds a colleague's.** The spec says nothing. For the colleague case the field is therefore not what is on disk. Its node is the one analysed right after this commit's write (the colleague's save arrives through the watcher).
7. **Ruling 6 compares the hash of the disk with the hash of the bytes this commit wrote.** A colleague who saves byte-identical content is indistinguishable from us, and the file is put back. Harmless, but not "never overwrite a colleague" in the strict sense. The window between the read and the put-back write is named in a `ponytail:` comment, as the spec asks.
8. **The commit's own writes have no equivalent of ruling 6.** Prepare reads the disk, and the write happens later, possibly after other sources' writes; a colleague saving in between is overwritten (rebase-free). Not new (it was per file before), but with N files the window is wider. Closing it needs a host verb that writes only if unchanged; FR-006 forbids a new verb.
9. **The put-back writes `p.disk`, the bytes read in prepare, not the session's base bytes.** They are the same unless the disk moved and prepare rebased; then the put-back restores the rebased-onto disk, which is what the staged edits now stand on. Chosen because the spec says "the bytes remembered in FR-003".
10. **A throw in the write phase still removes written sources' edits** (FR-012), and now also the sources written after a *handler* throw are never written (see the test left alone above). Which of the three outcomes of a handler throw (half-applied, undone, impossible because analysed in prepare) is wanted is the owner's.
11. **Breaking changes to name in the CHANGELOG** (no bump made): `CommitReport.outcome` is a new required field; `SourceCommit.outcome` gains `aborted` and `unrestored` (an exhaustive `switch` stops compiling); a commit with one bad source now writes nothing where it wrote the others. Also: a single source that is `refused` or `conflicted` now yields report outcome `aborted`.
12. **A put-back source's staging has `waiting` and `version` as prepare left them**, and the memory host's watcher reports both writes of a put-back; the session finds nothing new. Tested by the retry in case 6.
13. **`Session.commit`'s doc comment in `src/index.ts` is rewritten** (it said "not atomic across files"). The README's "written to disk together" was already the claim; I did not touch it.
14. **Rulings 5 and 6 are the coordinator's defaults** per the spec's status; I built them as written and they are the lines to change if the owner differs.

## Wording I would want

**Glossary, "Commit".** Writing every staged edit to disk, all or none. Each source is checked and rebased first (a file that no longer hashes to its base version is rebased; a value changed on both sides is written as staged and reported); if any source cannot be written, or any edit is dropped, nothing is written and every edit not dropped stays staged. Otherwise the files are written one at a time, each atomically by the host, and if one write fails the files already written are put back, newest first, unless someone has saved them since, in which case they are left and reported `unrestored`. Afterwards the written versions become the base versions and the index empties. Not a version-control commit; one may follow, and that is the consumer's call. *Amended 2026-10-29 (`specs/atomic-commit/`): it was one file at a time, a failure on one leaving the others written.* *(editing)*

**`docs/write-back.md`, replacing "Saving several files at once".** *Saving several files at once* — built (2026-10-29, `specs/atomic-commit/`): a commit lands every staged source or none. Every source is checked and rebased before any is written; a refusal, a failure or a dropped edit stops the commit, and a failed write puts back the files already written, after checking each still holds what the commit wrote. Parked, and back when needed: a journal for a process that dies mid-commit (Mercurial's transaction journal); a host verb that writes only if the file is unchanged, closing the window between the check and the put-back; groups and a partial commit of one file's edits; a per-commit mode that lets the others land.

## FR-012, ruled (after the first report)

The owner ruled: analyse each source's new text in prepare, before any write. Done in `prepare`, after the bytes are built, the way `preview` does (`findingsFor` on the decoded spliced text, held through `inFlight`). A handler that throws now rejects the commit with nothing on disk; `serialize` restores the snapshot, so every edit is staged as before (witnessed for two sources, the second throwing: both disks byte-identical, `index()` equal to what it was).

- **Counts, by the counting handler:** a commit of two clean sources analyses 2 texts in total, so the `load` after each write hits the cache (sabotaged: bypassing the cache turned "FR-010: the session absorbs its own write by re-analysing, once" and the new case red). The throwing case analyses 2 (the first source's text, then the second's, which throws).
- **Existing test changed, by design:** editing "a handler that throws on the written text rejects the commit, and the file stays committed" is now "a handler that throws on the new text rejects the commit with nothing written, before or after it". The source before the throwing one (`/v.conf`) is no longer written either; all three edits stay staged; after unstaging the throwing one, a second commit writes the other two.
- **Sabotage:** analysis skipped in prepare: 2 red (the new case and the changed test).
- **Left as it was:** the per-file `load` right after each write (kept from the first round) is now only a cache hit; it still matters for the `fresh` node. A host-write throw in the write phase keeps today's behaviour (written sources' edits leave the index, no undo); the realistic throw, the handler's, no longer reaches it.
- **Found:** a handler that throws on the *old* disk text during `load` after a rebase is untouched by this; only the new text is analysed in prepare. A file with no handler, or whose new bytes do not decode, is skipped as `preview` skips it.
