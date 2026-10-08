# Report: fixes before 0.5.0

Tests 160 before, 172 after (12 new: 1 + 1 for fix 1, 3 for fix 2, 7 for fixes 3 and 4; plus assertions
added to cases 4 and 8). `npm test` green three runs in a row; `grep -rn SABOTAGE src test` empty. No
version bump; `docs/` and the kernel spec untouched.

## Commits

- 8ae19a6 `feat: one value type across the two libraries; an edit sets a scalar (EditValue)` (plan included)
- 99d82ba `fix: a rebase rechecks overlap; the later-staged of two overlapping edits is conflicted`
- 894a78c `test: editTarget through a symlinked path, a read pass racing a commit, cases 4 and 8 read back through Cascata`
- 22ea3bd `test: a writable root in another letter case still contains its files on a case-folding disk`

## Fix 1: `EditValue`

`export type EditValue = string | number | bigint | boolean | null`, Cascata's own name and members,
used in `Writer.write`, `session.stage` and `StagedEdit.value`. There was no annotation left to
remove (the `Parameters<typeof w.write>[2]` wrapper only ever existed in the predecessor's
sabotages); instead a test writes that wrapper **unannotated**. Red first (both `tsc` errors):
the `// @ts-expect-error` on an object value was "unused", and the unannotated arrow wrapper failed
with `'unknown' is not assignable to 'EditValue'`.
Sabotage: `EditValue = unknown` turned exactly those two compile errors back on.

## Fix 2: overlap after a rebase

`rebase` keeps a list of the edits it has kept; a rewritten edit that overlaps one of them is
conflicted (dropped, `Change.edits` outcome `conflicted`, and in the commit report when the commit
meets the moved disk). The test writer answers `b` over `a`'s range once the bytes begin with a `!`
line. Three tests, red first (all three): via the watcher; via the commit alone; and "later-staged".
**"Later-staged" needed a second change**: restaging replaced an edit *in place*, so the list order
was first-staged order. A restaged edit now moves to the end, so the list is in staging order.
Observable: `index()` lists a restaged edit last (no existing test pinned the old order).
Sabotages: the check disabled (`kept.length > 99 &&`): all three red. Restage in place: only the
"later-staged" test red.

## Fix 3

- **(a) `editTarget`, stage, commit behind a symlink.** Two tests: a directory made under
  `os.tmpdir()` as it spells it (`/var/folders/...`, behind `/var` to `/private/var`), and one behind
  a symbolic link the test makes (so the property holds where `tmpdir` has no link). Green at first
  except for one assertion of mine: **Cascata answers `origin.id` as loaded, `/var/...`, not the
  canonical spelling** (the joining report's point 5 guessed right: `stage` canonicalizes it). The
  test therefore asserts only that `realpath(target.location)` is the file. The commit reports the
  canonical location. Sabotages: `isWritable` not canonicalizing the root: both red (the previous
  tests all used `realpath`ed directories, so nothing guarded this); `keyFor` without canonicalize:
  both red.
- **(b) A read pass racing a commit.** Tested: (i) on the memory host, a commit held *before* and
  *after* its disk write, a pass loading the cascade through Cascata meanwhile: Cascata saw the old
  (3.2) or the new (3.4) value, its one read of the file hashes to the manifest's version, the
  session ends on the committed version, and the pass reports a mismatch (a second `changed`) exactly
  when it saw the old file; (ii) a pass that read before a commit and ends after it; (iii) on a real
  disk, six rounds of a 1.5 MB file with reads in a tight loop while the commit runs: every read is
  the whole old or whole new file, and the manifest's version is that of the last bytes handed out.
  Sabotages: the Node host writing in place instead of renaming: (iii) red 3 of 3 runs; `endPass`
  ignoring a mismatch: (i, held before), (ii) and the existing manifest test red.
  **Not tested, cannot be here:** a non-atomic rename (Windows, network file systems); a crash
  mid-commit; a pass that ends *during* a commit (it cannot: `end()` queues behind it, so (i) shows
  serialization rather than a race the session wins); a pass that reads a file twice (Cascata reads
  it once, which the test asserts; a double read would record only the last).
- **(c)** Cases 4 and 8 now read back through `parse` (value and kind; the other wall unchanged).
  Added to the existing tests, nothing removed. With a writer that truncates `3.4` to `3` and the
  byte assertions removed, case 4's read-back went red alone (`['float', 3]`); the read-back adds
  nothing over exact bytes except an independent reading, since equal bytes parse equally.

## Fix 4

One test, skipped (with a stated reason) unless a probe in a temporary directory finds the file
system folds case (here: yes). It gives `writable` as the upper-cased true path, asserts
`host.canonicalize(upper) === true path`, stages and commits. Sabotages: `isWritable` not
canonicalizing: red; the Node host's `canonicalize` using the non-native `fs.realpathSync`: red
(only this test), so the test pins "native". It could not be run where the file system is
case-sensitive, so the skip branch is unexercised.

## Documents silent, contradictory or wrong

1. **The contract** (`specs/source-graph-kernel/contracts/public-api.md`, lines 37, 96, 106) and
   **`specs/editing/spec.md` FR-001** still say `value: unknown` and "`value` is opaque". Should say
   `EditValue`. The **glossary** has no entry for the value type; I used Cascata's name, `EditValue`.
2. **`docs/write-back.md`**: the lifecycle (step 3) names three rebase outcomes; a fourth now exists
   (found, but overlapping an earlier staged edit: conflicted). The glossary's **Conflicted** says
   "target gone"; it now also means "its new range overlaps a staged edit". Neither says *which* edit
   yields; I chose the later-staged. The editing spec FR-006 calls overlap a writer bug refused at
   staging; after a rebase it is not necessarily a bug (the text moved), so "writer bug" is wrong there.
3. **A conflicted edit still carries no reason** (the handoff's second open edge): an overlap and a
   vanished path are both a bare `conflicted`.
4. **Invented:** `EditValue` as the name; moving a restaged edit to the end (changes `index()` order);
   the earlier-staged winning; asserting only `realpath(location)` for `editTarget`; the 1.5 MB and
   six rounds of the race test (tuned until the in-place sabotage failed every run; a fast machine
   could in principle pass it by luck); upper-casing the whole path for the case test.
5. **Joining report point 4** (bivariance) is now resolved; point 5 (symlink) confirmed; point 7
   (racing) addressed as above; point 6 (cases 4 and 8 not parsed) closed.
6. **Handoff's "Open edges"** lists the sandbox as unhandled for case-insensitivity; on macOS it is
   handled and now tested. Windows drive letters and a root that does not exist yet are not.
7. **Test hygiene found, not fixed** (not mine): `node-host.test.ts` leaves four `provenance-*`
   directories in the temporary directory per run (403 had accumulated), and the real-disk tests
   there and in `joining.test.ts` do not close their sessions on failure, so a failing assertion
   hangs the runner.

## The handoff note

Very useful: the map of `session.ts`, "add new state to the snapshot" (no new state was needed, which
the note let me see quickly), the `memory.write` double role and the isolation idioms, and the
method. What it lacked: that a failing real-disk test hangs rather than fails (cost two stuck runs),
that macOS has no `timeout`, that the leaked temp directories exist, and the rule for what order
`staging.edits` is in (it is read by `rebase`; the note's "edits" description did not say). A short
addendum covering these is at its end.

## Round 2

Tests 172 before, 174 after. Commits: e1064c2 `feat: a conflicted edit carries its reason (gone,
overlap or unwritable)`; 57b615d `test: every Node-host test closes its session and removes its
directory when it ends, however it ends`.

### A conflict carries its reason

`ConflictReason = "gone" | "overlap" | "unwritable"` (exported; in `src/index.ts` and the contract).
`EditNotice.reason` and the commit report's per-edit `reason` are present exactly when the outcome is
`conflicted`. Paths in `session.ts`: `locate` fails on the new bytes: `gone`. The source is refused,
external, unreadable, or leaves the graph (`conflict(key)`): `gone` too, which the owner's list did not
name; I read "the target is no longer there" widely. `write` refuses on the new bytes after `locate`
found the path: `unwritable`; this path **existed** before (the `!again.ok` branch of `rebase`), only
untested. Overlap with an earlier-staged edit: `overlap`.
Tests first, red as compile errors (`reason` did not exist): the existing case 6 tests (notice,
unabsorbed commit), the vanished-source test and joining's case 6 now assert `gone`; the two fix 2
tests assert `overlap` in notice and commit report; two new tests (via the watcher, via the commit
alone) assert `unwritable` with a writer that refuses once the bytes begin with `!`. Existing
assertions were extended, not relaxed (two whole-object `deepEqual`s gained `reason: "gone"`).
Sabotage, every conflict reported `gone`: 4 red (both `overlap` tests, both `unwritable` tests); the
`gone` tests cannot go red under it, by construction.

### Test hygiene

`test/helpers.ts` gains `scratch(t, prefix)` (a real-path temporary directory removed in `t.after`)
and `closing(t, session)` (closed in `t.after`). `node-host.test.ts` (all seven tests) and
`joining.test.ts`'s two real-disk tests use them; the explicit `close()` and `rm` calls at their ends
are gone. `real-disk.test.ts` already closed and removed in `finally`.
- **Directories:** `provenance-*` under the temporary directory, immediately before and after a full
  `npm test`: 87 and 87 (the coordinator's correction: not from zero). Before the change each run left
  four (`node-host.test.ts`'s `directory()`).
- **A failing real-disk assertion fails, it does not hang:** three real-disk assertions sabotaged at
  once (one each in `joining`, `node-host`, `real-disk`): the full run took **2.5 s** wall time,
  reported 3 failures, exited 1, and left no directory (87 and 87). Restored; `grep SABOTAGE` empty.
- **Not done, and a decision:** the memory-host tests (about 100 sessions) still end with a plain
  `session.close()`. A memory host has no watcher or timer, so a failing assertion there fails and
  cannot hang; wrapping them all would be churn. If the owner wants them uniform, `closing()` is the
  one-line change per test.

### Still wrong

`docs/write-back.md` and the glossary do not yet name the three reasons (the owner's call, not the
contract's). The 5 s timeout in `node-host.test.ts`'s `next()` can delay a failed run by up to 5 s.
