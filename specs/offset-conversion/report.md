# Report: offset conversion

Status: done through step 4. Tests 73 before the milestone, 85 after, all green; `grep -rn SABOTAGE
src test` is empty; version not bumped; `docs/` and the kernel spec not edited.

## Commits

- a9c98fb `test: a handler that throws makes the triggering session call reject` (step 1)
- ca4de0d the first version of this report, written when step 1 stopped
- 61628c2 `fix(session): a failed call changes nothing, an uncalled throw escapes` (step 2, FR-004-006)
- 3ecb89a `fix(offsets): a lone surrogate counts three bytes; an index it cannot convert throws a RangeError` (step 3)
- this report

## Step 1: what a throwing handler did before the kernel change

1. `openSession` and `addRoot` rejected with the handler's error.
2. A failed `addRoot` wedged the session: the root stayed, and every later `addRoot`, `removeRoot`
   and read-pass `end()` re-analysed it and rejected. Read passes did the same through
   `passRoots`. Only `removeRoot` of the bad key cleared it.
3. A throw during change-triggered analysis vanished: `queue = next.catch(...)` marked the promise
   handled, so no `unhandledRejection` fired (checked with a listener), no change was emitted, and
   the source stayed at its old version as `analysed`.

## Step 2: the kernel (`src/session.ts`)

- `serialize` snapshots `ids`, `nodes`, `roots` and `passRoots` before each piece of work and
  restores them if it throws, then rejects as before. This covers `addRoot`, `removeRoot`, a read
  pass's `end()` and the watcher's `absorb` alike. The queue still survives (`queue = next.catch`).
- The watcher's `serialize(...)` gets `.catch(error => Promise.reject(error))`, which re-raises as
  an unhandled rejection. One line. No `onError`.
- Tests: `test/throwing.test.ts`, five: rollback on `addRoot` (with a healthy source loaded before
  the throwing one, so a missing rollback shows in `sources()`), rollback of a read pass's label,
  a host `read` throwing on `addRoot` (FR-006), the handler throwing on a change (FR-005), the host
  throwing on a change. Each was red against the old code for the reason it names (the extra
  source in `sources()`; zero unhandled rejections seen).
- **Unhandled-rejection test under `node --test`:** the runner has its own `unhandledRejection`
  listener, which would fail the test. The helper `unhandled()` in `throwing.test.ts` saves
  `process.listeners("unhandledRejection")`, calls `removeAllListeners`, installs its own, runs the
  action, waits 20 ms, and restores the saved listeners in a `finally`. It worked first time.

Sabotage (backed up to `/tmp`, marked `SABOTAGE`, restored):

| Sabotage | Red |
|---|---|
| skip the restore | the three rollback tests (`addRoot`, read pass, host verb); the two watcher tests stay green |
| drop the re-reject | the two watcher tests |
| let the escaping throw break the queue (`queue = next`) | the two watcher tests **and** the three rollback tests, five in all |

The third is wider than the spec's "FR-005's later `addRoot` goes red": without the queue's
`catch`, any rejected call poisons the queue, so every FR-004 test's "next call runs" assertion
fails too. That is correct, but the spec's description undersold it.

## Step 3: the conversion (`src/offsets.ts`)

- The low-surrogate check is `isLow(text.charCodeAt(i + 1))`; a lone high counts 3.
- Not-an-integer, negative and past-the-end are checked up front for every index. Pair interior is
  detected inside the pass: after counting, `i > target` means the pair's second half was consumed
  to reach the target.
- Tests in `test/offsets.test.ts`: the table rows, the TextEncoder agreement test over seven
  lone-surrogate texts (expected values from `TextEncoder` on each prefix, indices built without
  `byteOffsets`), the throwing cases, and one session test (request `end` past the text rejects
  `addRoot` with a `RangeError` and leaves `sources()` unchanged). Red against the old code: five
  tests failed for the right reasons before the change.

| Sabotage | Red |
|---|---|
| drop the low-surrogate check | the first-four-rows test and the TextEncoder agreement test |
| drop the pair-interior check | only the throwing-cases test (its `x😀y` row), as the spec predicted |
| allow `text.length + 1` | the throwing-cases test and the session test |
| allow non-integers (only `NaN` still refused) | the throwing-cases test (`1.5`, `Infinity`) |

## Silent, contradictory or wrong — and what I invented

1. **The new kernel rule contradicts itself, or at least pairs two clauses that cannot both be
   satisfied as I read them.** `broken-is-reported-not-thrown` (as amended) says a session MUST NOT
   go on showing a source as analysed at a version whose analysis threw. FR-005 calls the old
   behaviour ("the session goes on showing the source at its old version as `analysed`") the
   defect. But the old version's analysis did not throw, and the data model has no state for
   "analysis failed". With the throw escaping and the batch rolled back, my implementation **still
   shows the source at its old version as `analysed`**, which is literally what finding 4 called
   wrong, though the rule's own wording is satisfied. I chose that because the alternatives
   (dropping the node, or inventing a state) are a kernel decision and dropping it would make every
   later call re-analyse it and reject, breaking "later calls run normally". If the intent was a
   visible failure state, the spec has to name one. The test asserts `sources()` unchanged and
   cannot distinguish the two readings.
2. **Rollback is not total.** I restore `ids`, `nodes`, `roots`, `passRoots`. Not restored: `Link`
   objects mutated in place by `link()` inside `absorb` (a host verb throwing there leaves some
   edges re-resolved against a node map restored to before); `livePasses`; the read pass's
   memoised `manifest` promise, so a second `end()` on a failed pass returns the same rejection. A
   listener that throws inside `emit` after a completed `settle` rolls back state the host watch
   was already told about (the watch set is not restored). The spec says "as it was before the
   call" without saying how far that goes.
3. **`absorb` is atomic, which the spec never said.** One throwing file in a batch discards the
   other files' updates in the same batch (they stay stale until the next event touches them; their
   versions are compared against the old ones, so they are re-detected). The alternative, keeping
   the good ones, would have left `settle` unrun and the watch set stale.
4. **FR-006 "test one"**: I tested a host `read` on both paths. `canonicalize` is untested.
5. **FR-003 for read passes:** "the call whose work met it" is `end()`, not `read()`. Stated nowhere.
   `end()` on a pass also rejects when its `read` was superseded? Not examined.
6. **The error messages are mine**: "index N is not an integer / is negative / is past the end of
   the text (length L) / is inside a surrogate pair". The spec says only "naming the index and the
   reason". `Infinity` is treated as not an integer; the spec lists neither.
7. **Spec table row 4 is written `"\ud800𐀀"`**; the character U+10000 is `𐀀`, so the row
   is the text `\ud800𐀀` (indices 0, 1, 3 mean: start, between the lone and the pair,
   end). It reads fine once you spell it out, but the glyph hides it.
8. **The spec's description of sabotage 3 for the kernel** (above) undersold what goes red.
9. **The "no `onError`" decision has a consequence the spec should say aloud:** on a Node host the
   first bad change report stops the process by default. For a long-running embedder (BelType's
   dev server) that is a decision, not a detail.

## What should change in docs I did not edit

- `specs/source-graph-kernel/contracts/public-api.md:77` says of `analyze` "throwing is a bug and
  propagates". It should add where it propagates to (the call, or an unhandled rejection) and that
  the session is left unchanged.
- The kernel's `data-model.md` rules 3-5 (absorb, `addRoot`, read-pass end) should state atomicity;
  I did not read it in full.
- `docs/principles.md:106` ("Programmer errors throw") is still true; nothing contradicts it.
- The version is not bumped. This is a behaviour change to a public contract (a failed call now
  rolls back; a change-triggered throw now escapes), which an embedder can observe, so it is more
  than a patch.

## Step 5: two rollback gaps, and the rest of finding 2

Commit 6969370. Tests 85 before, 89 after, all green. The kernel rule was amended again (d767dd3):
after a throw the session stays at its last good state and the escaping error says so (so finding 1
above is settled: keeping the old version `analysed` is right), and rollback covers the session's
own work only, not a listener's.

1. **Links.** `serialize` now also snapshots every link's `target` and `probes` (the two fields
   `link()` mutates in place) and puts them back on a throw. Test, written first and red: an
   embedder's resolver aliases a request to `/b.md`, then `/c.md` once a probed file changes; one
   batch re-resolves that link, then a host `canonicalize` throws for a later link. After the throw
   `edgesFrom` has to show the alias at `b` again (it showed `c`). My first attempt, with two
   missing files that appear, did **not** go red: the edge view omits a `target` that is not a
   session source, so the in-place mutation was invisible there. A resolver that targets an
   existing source was needed to see it.
2. **Listeners.** Work (`report`, `endPass`, `absorb`) now returns the `Change` instead of emitting,
   and `serialize` announces it after the work is kept, outside the rollback. A listener's throw
   rejects the call (or escapes on the watcher path), the session keeps its new state, and the
   queue survives. Tests: `addRoot` rejects with `sources()` showing the new root; a change
   escapes with the source at its new version.
   - **Invented:** `emit` calls every listener even if one throws, then rethrows the first error.
     Before, the first throw starved the others. The spec says nothing about several listeners; a
     test pins mine. Later errors are dropped silently, which is the cost.
3. **`livePasses`, `manifest`, the watch set.** None can leave the session inconsistent; no change.
   - `livePasses` is deliberately not restored. It only decides whether a pass that ends is its
     label's newest; `finish()` deletes its entry before it queues the work, and a newer pass may
     have claimed the label while the work waited. Restoring would clobber that pass. After a
     failed `end()` the label has no live pass, which is what an ended pass leaves anyway.
   - The memoised `manifest` makes `end()` idempotent, a second call returns the same rejection
     and runs nothing. That is the contract of the memo, not an inconsistency: the pass has ended.
   - The watch set: `settle` sets it as its last act, after everything that can throw. A failed
     piece of work never reaches it, and a succeeded one has already set it before anything can
     fail, because the only thing after `settle` is the announcement, which is now outside the
     rollback. So the watch always matches the restored nodes. The earlier worry (a listener
     throwing after `settle`) is gone with item 2.
4. **Sabotage.** Drop the link restore: the links test, and only it, goes red. Emit inside the
   rollback again: both listener tests go red (the `addRoot` one and the change one); the
   "other listeners still hear it" test stays green, as it should.

**Still silent in the documents:** the kernel rule does not say what a listener's throw does to the
other listeners; it does not say which listener's error escapes when several throw (mine: the
first); and it says nothing about a listener that throws while the session is closing.

**Step 5, addendum: the probes restore was unguarded.** Sabotaging `l.probes = probes` out of the
restore left all 89 tests green: the aliasing resolver returned the same probe every time, so a
mutated `probes` looked identical. The resolver now probes a location named for its answer
(`/switch-/b.md`, then `/switch-/c.md`), so the failed batch changes the probes, and the test also
writes to the old probe afterwards and expects the restored link to re-resolve; without the
restore the edge's `probes` differ at the first `deepEqual`, and the later re-resolve would not happen either.
