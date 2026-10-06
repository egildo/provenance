# Report: offset conversion — stopped at FR-003

**Status: stopped after step 1. `byteOffsets` is unchanged.** FR-003 says to stop and report if a
throwing handler does anything other than reject the call that triggered it. It does, in two ways.

## What a throwing handler does (observed, HEAD 864e205 plus the new test)

Test handler: claims `.md`, throws `Error("handler broke")` when the text contains `BOOM`.

1. `openSession` with a throwing entry rejects. Fine.
2. `addRoot("/bad.md")` rejects with the handler's error. Fine. This is the committed test
   (a9c98fb, `test/session.test.ts`).
3. **The session is wedged afterwards.** `addRoot` adds the key to `roots` before it settles, and
   the throw leaves it there. `session.sources()` still shows the pre-call sources, but every later
   `addRoot`, `removeRoot` and read-pass `end()` re-analyses `/bad.md`, throws again and rejects.
   `removeRoot("/bad.md")` is the one call that clears it, and the embedder has no reason to
   guess that. The same happens through a read pass: `end()` rejects, `passRoots` keeps the key, and
   every later call rejects until a newer pass with the same label replaces the roots.
4. **A throw during change-triggered analysis is swallowed.** The host watcher calls
   `void serialize(() => absorb(locations))`. No call is waiting on it. `serialize` does
   `queue = next.catch(() => undefined)`, which marks `next` as handled, so no `unhandledRejection`
   fires (checked with a listener). Writing `BOOM` into an already-loaded `/b.md` leaves the session
   showing `/b.md` as `analysed` at its old version, emits no change and raises no error. The
   session is silently stale. Later work does run, since the queue itself survives.

## Why I stopped

(3) and (4) are kernel defects (`src/session.ts`), not this milestone's. They also bear on FR-002:
the conversion error would reach the embedder through (2) when an `addRoot` or read pass triggers
it, but through (4), swallowed, when a file change does. The error FR-002 asks for would be lost in
the case most likely to meet it.

I did not fix them, did not write FR-001/FR-002, and did not touch the cache.

## Spec and kernel-spec findings

- **The conformance line "the session's later work still runs" is false today for `addRoot`**
  (finding 3). It is true after a change-triggered throw, but only because the throw is swallowed.
  The spec has to say which it means.
- **FR-003 assumes a throwing handler "rejects the call that triggered it".** That only holds when a
  call triggered it. The kernel spec's `broken-is-reported-not-thrown` ("a handler that throws [is
  a] programmer error and MUST throw") does not say where it throws to when nothing is calling.
  The kernel spec is silent on the watcher path, and the code's answer is "nowhere".
- **The kernel spec is silent on session state after a throw.** Whether the root added by the
  failed `addRoot` stays is unspecified.
- **No test ever covered a throwing handler** (confirmed: `grep -n throw test/`). I committed only
  the passing half. I did not write tests pinning (3) or (4), since they are defects and a test
  pinning them would enshrine them.
- Not checked: the dependency on `broken-is-reported-not-thrown` for host `read`/`canonicalize`
  throwing, which share the same `serialize` path.

## Decisions needed from the owner

1. Where does a throw from change-triggered analysis go? Options: an `onError` listener, a
   rejected `close()`, or marking the node. Any needs a kernel-spec amendment or reading.
2. Should a failed `addRoot` / read pass roll its root back?
3. Then FR-002/FR-003 can be re-scoped, and the "later work still runs" row rewritten.

## Details I invented

- The test handler and its `BOOM` marker (the spec asked for a handler whose request `end` exceeds
  the text; I used a direct throw to observe the kernel path, not the conversion path).
- The test covers `openSession` and `addRoot` only, not read passes.

## Commits

- a9c98fb `test: a handler that throws makes the triggering session call reject`
- this report

Tests: 73 before, 74 after.
