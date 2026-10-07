# Report: findings live while a session holds them

Tests 89 before, 97 after (8 new), all green; `grep -rn SABOTAGE src test` empty; no version bump;
the kernel spec and `docs/` not edited.

## Commits

- 793bd22 `feat(session): findings live while an open session holds their version`
  (`src/session.ts`, `test/held.test.ts`, `test/throwing.test.ts`)
- this report

The cases and the code are one commit: the runner has no expected-to-fail marker, and a red commit
would break `npm test` for the next step. Before the code, cases 2 and 3 were red (and only those),
as the brief predicted.

## The shape, and why

A module-level `open` set: each open session registers a generator `holds()` yielding
`[handler, version]` for each of its `analysed` sources, recomputed from its live `nodes`.
`sweep(handlers)` collects what every open session holds and deletes from those handlers' caches
every version nobody holds. It runs in a `finally` after each piece of serialized work (so after a
rollback has already restored `nodes`, and a rolled-back session holds its restored versions), and
in `close()`.

- **Why not counts per version.** A count has to be kept in step with every `nodes.set`, `delete`,
  and every rollback restore, which is exactly where the earlier rounds found defects. Computing
  holds from `nodes` on demand has one source of truth, and the restore fixes it for free.
  Ceiling (marked `ponytail:` in the code): a sweep walks every analysed source of every open
  session, per piece of work.
- **Why sweep only the session's own handlers.** A session adds only to its own handlers' caches, so
  an unheld finding can only be in one of them. No iteration over the `WeakMap` is needed.
- **Why `busy` and `dirty`.** See finding 1.

## Sabotage (backed up to `/tmp`, marked `SABOTAGE`, restored)

| Sabotage | Red |
|---|---|
| never drop | cases 2 and 3 |
| drop regardless of holds | cases 1, 4, 5, 6, and the existing "rewriting identical bytes" test |
| ignore `busy` (sweep while another session is mid-work) | the across-sessions case 7 only |
| sweep at the start of every `load`, ignoring `busy` | case 6 and the across-sessions case 7 |
| release a closed session at the next piece of work, not at close | case 2 |
| sweep inside the rollback `catch`, before `nodes` are restored (my own) | case 6 |

## Silent, contradictory or wrong, and what I invented

1. **The spec's "never mid-work" is not enough once there are two sessions, and it says nothing
   about them.** FR-002 speaks of "a piece of a session's serialized work", but the work of two
   sessions interleaves at every `await`. Session B ending a piece, and sweeping, while session A is
   mid-piece drops a finding A cached and no source holds yet, because `load` caches it and only
   later does `nodes.set` hold it, with awaits on link resolution in between. A then re-analyses a
   version it analysed moments before in the same piece, violating FR-002's own "within one piece of
   work a version is analysed at most once". I added a module-level `busy` counter and `dirty` set:
   a sweep waits until no session has a piece running, and the last to finish does it. This is
   invented; the spec should say it. A test pins it (it goes red without it).
2. **The spec's sabotage list is wrong in two places.**
   - "drop mid-work (case 7 or 6 goes red)": the single-session case 7 never goes red. A source holds
     its version as soon as `nodes.set` runs, so a mid-work sweep inside one session cannot drop
     what its twin needs. Case 6 goes red, and the cross-session case I added.
   - "never drop (case 3 goes red: two calls, not three)": right, but case 2 also goes red.
   Case 7 as written is a true statement that no sabotage can break. I kept it as a guard.
3. **Case 5 and case 7 (single session) pass against the old code too**, so they are guards, not
   red-first cases; case 6 also passed before the change. The brief only promised 2 and 3 red.
4. **A session that fails to open.** `openSession` rejects, and the caller has no handle to close.
   The session was registered, so it would have held its versions forever. The spec says nothing. I
   close it in the failure path. That also closes its host watcher, which the old code leaked on a
   failed open; a behaviour change nobody asked for, and a good one.
5. **`close()` while the session is mid-work.** Its holds go at once; the sweep waits for the
   running piece to end (finding 1). The spec's "when a session closes" is read that way.
6. **Handler identity for holds is recomputed with `claims`.** A node records no handler, so `holds()`
   calls `handlers.find(h => h.claims(key))`, the same lookup `load` used. If `claims` is not pure
   the hold could name a different handler than the analysis did; the kernel says claims is pure,
   so I relied on that rather than adding a field.
7. **`counting()` is copied into `test/held.test.ts`**, not imported: it lives in `change.test.ts`,
   and importing a test file would run its tests twice. Moving it to `helpers.ts` would have edited
   `change.test.ts`, which the brief said to leave alone.
8. **Case 4's "second session holds its own copy at v1"** needs a second host (same bytes, other
   location store); one memory host cannot give two sessions different views. Invented.
9. **Case 6 uses a batch of `b.md` moving, then `c.md` throwing**, in node order, and relies on
   `absorb` loading touched nodes in `nodes` order; true today, not a documented guarantee.

## Docs and specs that should change (not edited)

- `specs/source-graph-kernel/data-model.md:66-67`, rule "Cache": "The cache survives across sessions
  sharing a handler" is true only while some session holds the version. It should say so.
- `specs/source-graph-kernel/plan.md:62` ("Findings are cached by handler and version") and
  `tasks.md` T014 describe the cache as a plain `WeakMap<Handler, Map<version, Findings>>`; still
  true as a structure, no longer the whole story.
- `docs/design-synthesis.md:128`, `docs/principles.md:30` and `README.md:86` say "cached by handler
  and content hash" and promise no lifetime; none contradicts this, none needs change. The glossary
  entry for **Artifact** ("cached by version") will need the same sentence when artifacts are built.
- `FR-002` of this spec: add the cross-session rule (finding 1).
- Release: an observable kernel promise changed (analyses can repeat), so 0.4.0 is right.
