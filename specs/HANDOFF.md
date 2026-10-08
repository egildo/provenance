# Handoff: what the specs, reports and docs do not say

For a fresh implementer who has read `README.md`, `docs/principles.md` and `docs/glossary.md`. The
rest (`specs/*/spec.md`, `report.md`) says *what* was decided; this says where things are, what bit
me, and what I left open. Written after nine rounds (offset conversion, held versions, editing in
two rounds, joining); the code is the truth where this note and it disagree.

## Where things live

`src/session.ts` is one closure, `openSession`. Module level holds only the findings `cache`, the
`open` registry and `sweep`. Everything else is per session.

- **`serialize(work)`** is the only way session state changes. A piece of work runs alone (queue
  chained on a promise). Before it: snapshot. If it throws: restore, then rethrow. `finally`: clear
  `inFlight`, `sweep`. After success: announce the `Change` the work returned (outside the rollback,
  so a listener's throw undoes nothing). The queue survives a rejected piece (`queue = next.catch`).
  The watcher path adds `.catch(e => Promise.reject(e))` so a throw nobody called escapes as an
  unhandled rejection (deliberate; `unhandled()` in `test/helpers.ts` observes it).
- **The snapshot** copies `ids`, `nodes`, `roots`, `passRoots`, `staged` (deep: edits cloned) and
  each link's `target` and `probes` (links are mutated in place by `link()`). **Deliberately not
  restored:** `livePasses` (a newer pass may have claimed the label while the work waited),
  the read pass's memoised `manifest` (a second `end()` returns the same result, rejection too), the
  watch set (`settle` sets it last, after anything that can throw), and listeners. **A new piece of
  state must be added to the snapshot and to the restore**, or a failed call leaks it. Every
  round's defects were here.
- **Held versions.** `open` holds one `holds()` generator per open session, yielding `[handler,
  version]` for its analysed nodes, its `inFlight` (what the running piece analysed or took from the
  cache, so another session's sweep cannot drop it mid-work) and each staged source's analysed
  preview. `sweep(handlers)` drops cached findings nobody holds. It runs after every piece (after
  the restore) and in `close()`. There is no global "busy" flag (it starved; see held-versions
  report). `findingsFor` is the only place that reads or fills the cache. A failed `openSession`
  closes itself, or it would hold its versions forever.
- **Editing state.** `staged: Map<key, Staging>` (writer, base version, **base bytes**, edits,
  preview version). `Node.bytes` is kept for every source a **writer claims**, for the session's
  life: it is the base `stage` uses and what `rebase` reads. `adopt(key, fresh)` is the one door for
  a new version of a staged source (called from `absorb` and `endPass`): it rebases, or conflicts if
  the source is unreadable. `rebase` locates, then calls the writer's `write` again on the new bytes
  (never reuses bytes), compares the old and new value bytes for `overrides` (sticky), and pushes
  `EditNotice`s (`moved`, `overrides`, `conflicted`, `respelled`) onto `notices`, which the next
  `Change` drains. `commitSource` per file: sandbox check, host `write` present, read the disk,
  rebase if its hash is not the base, write, drop the edits, reload the node. It pushes each written
  key onto `writtenKeys`; the `catch` in `serialize` removes those keys' edits *after* restoring,
  because a disk write cannot be rolled back (the file is on disk, the node catches up when the host
  reports the change).
- **Offsets.** `src/offsets.ts` `byteOffsets` is the one place string indices become bytes; it
  throws `RangeError` for anything it cannot convert (handler bug). Writers speak bytes already.
- **Hosts.** `src/memory.ts` (tests, and any realm) and `src/node.ts` (the only `node:` import;
  `boundary.test.ts` sweeps for this and for Cascata not being named under `src/`). `Host.write` is
  optional; the Node host writes a temporary file in the same directory, then renames.

**Invariants a change must keep:** state changes only inside `serialize`; every piece's reads of
its own mid-work state are consistent with what a rollback restores; a finding in use by a running
piece is held; `Change` is announced after the work is kept; no `any`; nothing under `src/` imports
Cascata or anything not allowed by the role table in `boundary.test.ts`.

## Traps I hit

- **Unhandled rejections under `node --test`.** The runner has its own listener and fails the test.
  `unhandled()` (helpers) removes the listeners, installs one, runs, waits 20 ms, restores.
  A throw you did not expect from a watcher can also fail a *later* test with "asynchronous activity
  after the test ended": isolate the watcher with `{ ...memory, watch: () => ({ set(){}, close(){} }) }`.
- **`new TextDecoder().decode` strips a leading BOM** (`ignoreBOM` is a double negative). Case 8 of
  `joining.test.ts` failed once for the *test's* reading. Use `ignoreBOM: true`. The session's own
  decoder already does.
- **`createMemoryHost().write` is two things.** It is the test helper that changes the "disk" (and
  notifies watchers at the next microtask) *and* the host's `write` verb (it returns a promise).
  A session's own commit therefore produces a watcher event; the session already holds that version,
  so it reports nothing. Do not spy on it by replacing the host's `write` and then expect your
  test's own writes to be counted: write through the underlying `memory`.
- **A memo in a writer outlives a test** if you hang it on module scope (my sabotage of "reuse old
  bytes" turned case 8 red as well). Keep per-test state per test.
- **Method bivariance.** Cascata's `yamlWriter()` is assignable to `Writer` because interface
  methods are bivariant (`value` is `EditValue` there, `unknown` here). A wrapper written as an arrow
  function must annotate `value` as `Parameters<typeof w.write>[2]` or tsc rejects it.
- **BSD `sed -i` wants a suffix argument** (`-i ''`); half my one-liners died of it. I edited with
  small Python scripts (assert the old text is present, then replace) and sabotaged the same way.
- **`absorbed(session, root)`** waits for an in-flight host event by tick then `addRoot` of an
  existing root (queues behind it). It does not wait for the watcher's *debounce* on the Node host.
- **An edit view hides a mutation.** The first test of "links restored on rollback" passed without
  the restore: `edgesFrom` omits a target that is not a session source. A resolver that targets an
  existing source made the mutation visible. When a sabotage stays green, the assertion cannot see
  the thing; do not trust the test, fix it.

## Fragile or slow tests, and how I verify

- `node-host.test.ts` and the two real-disk tests in `joining.test.ts` sleep (watcher start, debounce,
  400 ms to see that the session hears its own write once). They are the slow ones and the likeliest
  to flake on a loaded machine; I ran them three times in a row before committing.
- `held.test.ts` gates on promises and polls `handler.calls` with `tick()`; if you change when
  analysis happens, re-derive the counts by hand (each case has its arithmetic in a comment).
- **Method.** Tests first, every expected value derived by hand or from `TextEncoder`, never from a
  run. Then sabotage each claim: copy the file to `/tmp`, apply a scripted edit with a `SABOTAGE`
  comment, `npm test`, read which tests went red, restore, `grep -rn SABOTAGE src test` before every
  commit. A sabotage that turns *nothing* red is a finding. Check for failures explicitly (`grep
  '^ℹ fail'`), a green-looking tail has fooled me.
- **Counting handler**: copy `counting()` into the file (importing `change.test.ts` would run its
  tests twice). **Separate views of one file**: a second `createMemoryHost` with the same bytes.
  **Isolating a path from the watcher**: the no-op `watch` wrapper above.

## Open edges (seen, not fixed)

- Overlap of two staged edits is checked at staging, not after a rebase moves them.
- A rebase whose writer refuses on the new bytes drops the edit as `conflicted` without a reason.
- A source that leaves the graph with staged edits has them dropped as `conflicted` (invented).
- After a throw mid-commit, the written file's node stays at its old version (and old `bytes`) until
  the host reports the change; a host that does not report its own writes leaves the session stale.
- `editTarget` returns the document's `origin.id`; I did not run it on the Node host (symlinked
  paths). `stage` canonicalizes what it is given, so it should hold.
- A read pass racing a commit is untested (the pass records what it read; the session reloads on a
  mismatch; unproven).
- The sandbox compares canonical locations by whole path segments; case-insensitive file systems,
  Windows drive letters and a root that does not exist yet (it falls back to `paths.resolve`) are not
  handled or tested.
- `@egildo/cascata` (dev dependency) is on GitHub Packages: cloning needs the token in `.npmrc`; CI
  needs it too.
- Not built: groups, position maps in the index, file operations, insert and delete, a CSS writer,
  stamps, Markdown units, the view-update policy, a grace period for released versions (undo costs
  one analysis), an `onError` listener for escaped throws (on Node the first one stops the process).
- Memory: a `Node` keeps its bytes for every writer-claimed source for the session's life.

## How the owner and the reviewer work (from my side)

- The owner decides every semantic question and picks the model each time; amendments to specs and
  the kernel go through the coordinator, and my reports are the input. **Report ambiguities
  unsoftened**: every place a document was silent, contradictory or wrong, and every detail I
  invented. That section has changed the specs more than the diff has (the cross-session sweep, the
  rollback gaps, "later work still runs", the joining fixture's `id`). When a spec's wording and the
  code cannot both be right, say which you chose and why; do not quietly pick.
- The reviewer verifies, does not relay: reruns the suite, reads the diff, repeats sabotages, and
  finds the thing the report did not (an unguarded `probes` restore; a busy counter that starves).
  Expect to be asked for one more test, not for a defence.
- Rules that never moved: commit each step the moment `npm test` is green, by explicit path,
  conventional messages with the co-author trailer; never amend, rebase or force-push; never push;
  no version bump (the owner releases); do not edit `docs/` or the kernel spec, report what should
  change; existing tests do not change to fit new work (a test I replaced was named in the report as
  deliberate). A background run is killed after 600 s of silence, so keep commands short.
