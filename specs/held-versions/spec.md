# Feature Specification: Findings live while a session holds them

**Feature Branch**: `held-versions` (committed on `main`)

**Created**: 2026-10-07

**Status**: Draft

**Input**: the third point of [egildo/provenance#3](https://github.com/egildo/provenance/issues/3),
raised by 0km against v0.2.1 and parked by `specs/offset-conversion/`: "the findings cache never
forgets a version". Decided by the owner on 2026-10-07: findings for a version live while some open
session holds a source at that version, and no longer.

## The defect

`src/session.ts` caches findings in a module-level `WeakMap<Handler, Map<version, Findings>>`. The
outer map lets a handler go; the inner one keeps every version of every source that handler ever
analysed, for as long as the handler lives. Shipped handlers are module constants, so in practice
that is forever. A renderer that restarts often never notices. A server that watches files for days
adds an entry on every save of every file and never reads most of them again. The growth is read
from the code, not measured; each entry is small (the requests list), so it is slow, but it is
unbounded.

The kernel rule `cache-by-handler-and-hash` promised the opposite of a bound: "the same bytes under
the same handler are analysed at most once". That promise was written before any long-running
consumer existed, and it is the thing this milestone revises — the owner's standing rule is that a
design statement is revised when evidence shows it wrong. The design principle it serves, "derived
facts are pure functions of versions", is **unchanged**: a finding is still a pure function of its
version, still shared, still never invalidated by a call. What changes is only how long a finding
is remembered once nothing holds it.

**Prior art, and why not the commonest choice.** Salsa, the incremental engine inside rust-analyzer
and the closest relative of this kernel, bounds its largest memoized results with a
least-recently-used store of fixed capacity. That needs a capacity, and no number is right for every
consumer; it evicts by traffic, not by meaning. Here a finding has an owner — the open sessions that
hold its version — so memory can follow ownership exactly, the way a tracing garbage collector keeps
what is reachable from its roots. The open sessions are the roots.

## Requirements

- **FR-001** A finding — the result of one handler's analysis of one version — is **held** while
  some open session has a source in its graph (`sources()`) that the handler analysed at that
  version. The cache keeps every held finding and **no other**, at every point FR-002 names.
- **FR-002** Unheld findings are dropped at **safe points** only: when a piece of a session's
  serialized work ends — kept or rolled back — and when a session closes. Never during a piece of
  work, so within one piece of work a version is analysed at most once, and a rollback never leaves
  the restored state holding a version whose finding was dropped mid-work.
  *Amended after implementation (2026-10-08): "never mid-work" is not enough with two sessions,
  whose pieces of work interleave at every `await` — one session's sweep could drop a finding
  another has just computed but not yet stored. A piece of work therefore also **holds** every
  version it has analysed or taken from the cache, until it ends. No sweep waits on another
  session: a first implementation that deferred every sweep until no session was working could
  starve on a busy server and stop for good behind one host read that never returns. The
  remaining cost is bounded and local: a piece of work that hangs holds only what it has met, for as
  long as it hangs.*
- **FR-003** Sessions share: two open sessions holding the same version use one finding, analysed
  once. Two sources in one session with identical bytes share one finding, as today
  (`test/change.test.ts`, "identical files share one analysis").
- **FR-004** Closing a session releases what it held. A finding another open session still holds
  survives; one nobody holds is dropped.
- **FR-005** A version met again after its finding was dropped is analysed again. This is the cost
  of the bound, accepted by the owner: an undo that returns a file to a version it left is one more
  analysis. A grace period for recently released versions is an addition for later, if a consumer
  ever measures undo as slow.
- **FR-006** Nothing is added to the public API. No embedder call evicts, pins or sizes the cache;
  `cache-by-handler-and-hash`'s "no operation MUST exist to invalidate it" stands.
- **FR-007** The kernel specification's `cache-by-handler-and-hash` is amended to say this (already
  written for this milestone; do not edit it). `docs/principles.md` needs no change: it never
  promised "forever". Check `docs/design-synthesis.md` and `docs/glossary.md` for any sentence
  that does, and report it rather than editing.

## Conformance

The cache is private, so tests observe it through a counting handler (`counting()` in
`test/change.test.ts`, which already exists for this), never through a hook added for the test.
Expected call counts are derived by hand from FR-001 to FR-005.

1. **Shared while held.** Sessions A and B open on the same file: one analysis. Close A; open C on
   the same file while B is open: still one.
2. **Dropped when nobody holds it.** Close every session; open a new one on the same file: two.
3. **A watching session forgets what it left.** One session; the file goes v1 → v2 → v1 by host
   writes, each absorbed: three analyses (v1, v2, v1 again), where today there are two.
4. **Held elsewhere survives.** As 3, but a second session holds v1 throughout (its own copy at v1,
   never changed): two analyses.
5. **Twins.** The existing identical-files test still passes unchanged, and after one twin changes,
   the other twin's version is still held: changing the first back costs nothing.
6. **Rollback.** A batch that moves a source from v1 to v2 and then throws (reuse
   `test/throwing.test.ts`'s throwing handler): after the rollback the session holds v1, and a
   later piece of work that meets v1 again does not re-analyse it.
7. **Within one piece of work.** One batch in which two sources reach the same new version: one
   analysis.

**Sabotage**, each watched red and restored (back up to `/tmp`, mark `SABOTAGE`, grep before every
commit): never drop (cases 2 and 3 go red); drop on every safe point regardless of
holds (cases 1 and 4 go red); drop mid-work (case 6 and a cross-session case go red; single-session case 7 cannot, since a
source holds its version the moment it is stored — corrected after implementation); release a closed session's holds
only at the next piece of work rather than at close (case 2 goes red: the new session's opening
analysis finds the old finding still cached).

**Existing tests.** None should change: no current test pins analysis across sessions after a close.
If one goes red, stop and report it.

## Out of scope

- A size bound, a least-recently-used store, or any setting (rejected above).
- Weak references or a finalization registry: when an entry would go would depend on the engine,
  and the JavaScript standard warns against relying on it.
- Artifacts (`docs/glossary.md`): unbuilt; when they come, they follow the same rule.

## Plan and tasks

One plan file. Commits, `npm test` green at each, by explicit path, never pushed:

1. **The cases**, red against the current code where they should be (3, and 2): commit them as
   failing only if the runner allows marking them expected-to-fail; otherwise commit with the code.
2. **The holds and the sweep** — FR-001 to FR-006. The shape is the implementer's: a module-level
   set of open sessions that can each answer what they hold is the obvious one; justify it in the
   plan.
3. **Report** — `specs/held-versions/report.md`, with every place this spec, the kernel
   specification or the docs were silent or wrong.

Do not bump the version; it is decided after verification (likely 0.4.0, since an observable kernel
promise changes).
