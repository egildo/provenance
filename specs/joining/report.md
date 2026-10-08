# Report: joining, the walking skeleton end to end

Tests 140 at the start of editing round 2 (141 after it), 143 after step 1, 154 after step 2, 160
after step 3. All green; three consecutive runs of the Node-host tests green. `grep -rn SABOTAGE
src test` empty. No version bump; `docs/` and the kernel spec untouched.

## Commits

- 16edd7d `feat(joining): Cascata as a dev dependency with a sweep; a respelled edit is reported`
  (FR-001, FR-002)
- 5d1d433 `test(joining): the geometry fixture, and write-back's cases 1 to 10 through Cascata's YAML writer`
  (FR-003, FR-004, FR-007)
- 0bc8900 `test(joining): the cascade through editTarget, and cases 1 and 3 on a real disk`
  (FR-004 to FR-006)
- this report

## How I split the work

- **`walls.yaml` is a data file; the cascade is `project.yaml`.** Cases 1 to 10 of `write-back.md`
  are about `walls.yaml`'s bytes (51, W2 at 47-50), so they go straight to `stage` with a pointer,
  through `yamlWriter()`, on the memory host. `editTarget` cannot be asked about them: nothing adopts
  `walls.yaml`, so it is in no cascade. The loop that *does* use `editTarget` (load through a read
  pass's host, `editTarget`, `stage` at the answer, `commit`, load again) runs on `project.yaml`,
  whose bytes I counted by hand (80 bytes, W1's height at 54-57; derived as 29 for the `$schema`
  line, 7 for `walls:`, 6 for `  W1:`, 12 for `    height: `). FR-004 says to run cases 1 to 10 "this
  way"; they cannot all be, and I say so below.
- Expected bytes in cases 1 to 10 are copied from `write-back.md` (47-50; 69-72 after a 22-byte
  comment; 27-30 under CRLF; 28-31 under a BOM; 39-49 for the note), and each case also asserts that
  every byte outside the range is unchanged (L3) and that Cascata reads the value back with the
  kind set (L2).
- The fixture is three files under `test/fixtures/geometry/`; `walls.yaml` is asserted to be 51
  bytes in the test.

## Sabotage (backed up, marked `SABOTAGE`, restored)

| Sabotage | Red |
|---|---|
| a writer that reuses its first answer (stale ranges and bytes) | case 3 (and case 8, because the memo outlives a test) |
| no `writable` | cases 1, 3, 4, 5, 7, 8, 9, 10 (2 and 6 write nothing, and stay green, rightly) |
| a writer that ignores CRLF | case 7 |
| skip `editTarget`, stage the merged pointer on the entry document | the inherited-value test |
| respell branch removed from the rebase | the respelling test |
| `@egildo/cascata` moved to `dependencies` | the dev-dependency sweep |
| an `import` of it added to `src/offsets.ts` | the sweep, and the existing import-role test |

## The respelling notice (FR-002)

A rebase that keeps an edit's range but whose writer now spells the value differently is reported
in `Change.edits` as outcome **`"respelled"`**, with the unchanged range. The spec says "like a
move"; a move already has a name, and a consumer cannot tell a move from a respelling if they share
one, so I added the outcome (the union widened in `src/index.ts` and in
`contracts/public-api.md`). The spec's word in FR-008 as amended is "respelling". If it should be
`"moved"`, that is a one-word change and the test pins it.

## Silent, contradictory or wrong

1. **FR-003 demands an `id` the fixture cannot have.** It says `walls` items demand `height` and
   `id`, and that `project.yaml` is "keyed by id (`W1`, `W2`), each with `height`". If `id` is
   demanded inside each wall, the fixture fails validation; if the key *is* the id, there is
   nothing to demand. I demanded `height` only (a required float).
2. **FR-004 cannot be run for cases 1 to 10 as written** (above): they are about a data file,
   which `editTarget` has nothing to say about.
3. **"Reported like a move"** (FR-002) versus a distinct outcome: see above.
4. **`Writer.write`'s `value` is `unknown` here and `EditValue` (`string | number | bigint |
   boolean | null`) in Cascata.** Cascata's writer is assignable to Provenance's `Writer` only
   because interface methods are bivariant; a wrapper written as an arrow function must annotate its
   `value` as `Parameters<typeof writer.write>[2]` or the compiler rejects it (I hit this writing
   the sabotages). Staging an object value would reach Cascata's writer at run time, which refuses
   it as a diagnostic; Provenance has no type to stop it. Not exercised here.
5. **The edit target's `location` is the document's `origin.id`.** On the memory host it equals the
   session's key. On a host where a path has symlinks (macOS `/var` to `/private/var`) the origin id
   might not be canonical; `stage` canonicalizes the location it is given, so it would still find the
   source, but I did not run `editTarget` against the Node host. FR-006 only covers direct staging.
6. **FR-007 says "after every commit, Cascata reads the committed file".** I read back (kind and
   value) in cases 1, 3, 5, 7, 9 and 10, the cascade test, and compare bytes in 4 and 8; cases 2 and 6
   commit nothing. Case 8 does not parse the BOM file back through Cascata; it checks the three BOM
   bytes and the splice.
7. **No genuine test of a read pass racing a commit.** The loop loads the cascade before staging and
   again after committing; what Cascata saw between is not compared to what the session holds. The
   read pass records the versions it read, and the session reloads on mismatch, so it should be
   safe; unproven.
8. **The dev dependency needs credentials to install.** `@egildo/cascata` is on GitHub Packages, so
   anyone cloning the repository needs the `.npmrc` token this machine has; the lock file records the
   registry URL. CI, when it exists, needs the same. Cascata's `yaml` dependency comes with it
   (dev only; nothing in `src/` loads it).
9. **A trap in my own test helper, worth a line in a handoff:** `new TextDecoder().decode` strips a
   leading byte-order mark by default (Cascata's `CLAUDE.md` records the same double negative as
   `ignoreBOM`), so case 8 failed once for the test's reading, not the library's. The file's `text`
   helper now passes `ignoreBOM: true`.

## For a successor (what I would want to know)

- **The shape of the code.** `src/session.ts` is one closure: `serialize` is the only way state
  changes (snapshot, work, rollback in `catch`, sweep in `finally`, announce after). New session
  state must be added to the snapshot *and* its restore, or a failed call leaks it; the held-versions
  `holds()` must name any new thing that keeps a version alive.
- **Test idioms.** `createMemoryHost` events arrive at the next microtask, so `absorbed(session,
  root)` is the way to wait for one; `memory.write` is also the Host's `write` and notifies; a
  wrapper host `{...memory, write, watch: noop}` isolates a path from the watcher; `unhandled()` in
  `test/helpers.ts` is how to observe an escaping throw under `node --test`. Counting handlers are
  copied per file on purpose.
- **Method, as practised here.** Tests first (red as a compile error counts only as "not built"),
  expected values by hand, then sabotage each claim: back up to `/tmp`, mark `SABOTAGE`, `grep`
  before every commit. BSD `sed -i` needs a suffix argument; I used small Python scripts for
  sabotage instead.
- **Decisions the owner made that are not obvious from the code:** a failed call changes nothing
  (rollback), an uncalled throw escapes, listeners run after the work is kept, findings live while a
  session holds their version (including a running piece's), a commit's disk writes survive a throw,
  staging never refuses a moved disk, a rebase writes the value again.
- **Still open:** how a session catches up when a host does not report its own writes after a throw;
  editing a source that leaves the graph; the glossary's groups and position maps; a CSS writer;
  insert and delete; the view-update question (`edit-target-inherited` is the honest answer today).
