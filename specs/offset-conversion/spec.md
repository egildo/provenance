# Feature Specification: Offset conversion refuses what it cannot convert

**Feature Branch**: `offset-conversion` (committed on `main`)

**Created**: 2026-10-06

**Status**: Draft

**Input**: [egildo/provenance#3](https://github.com/egildo/provenance/issues/3), raised by 0km
against v0.2.1: "`byteOffsets` takes a lone surrogate for a pair and converts out-of-range indices;
the findings cache never forgets a version". This milestone takes the first two. The third is
parked (below) pending a decision, because it conflicts with a MUST in the kernel specification.

`byteOffsets` (`src/offsets.ts`) is the one place string indices become byte offsets — the design
principle "one address space" rests on it. None of the defects below is reachable as a wrong answer
through the shipped handlers today: the session decodes with `fatal: true`, which never produces a
lone surrogate, and the shipped handlers read positions from parsers. Both become reachable once a
handler computes its own positions, which the units proposal
([egildo/provenance#2](https://github.com/egildo/provenance/issues/2)) invites.

**The byte-order mark needs nothing here.** Provenance already counts it, as the kernel
specification says ("a byte-order mark is the first bytes of the source; offsets count it").
Cascata changes to match, in its own v1.9 (`specs/017-stored-bytes/` there); this note exists so
the two can be read together.

## Requirements

- **FR-001** A high surrogate (`0xD800`–`0xDBFF`) counts as the first half of a four-byte character
  only when the next code unit is a low surrogate (`0xDC00`–`0xDFFF`). Otherwise it is a lone
  surrogate and counts three bytes, which is what `TextEncoder` produces for it (U+FFFD), and the
  next code unit is counted on its own. A lone low surrogate already counts three; keep it so.
- **FR-002** An index `byteOffsets` cannot convert is a **handler bug** and throws: one that is not
  an integer (`NaN` and `1.5` included), is negative, exceeds `text.length`, or falls between the
  two halves of a surrogate pair. `text.length` itself is valid (the end of the text). The error is
  a `RangeError` naming the index and the reason. It is thrown, not reported as state, under the
  kernel rule `broken-is-reported-not-thrown`: "a handler that throws [is a] programmer error and
  MUST throw".
- **FR-003** The error reaches the embedder by the kernel's rule for any throw
  (`broken-is-reported-not-thrown`, amended 2026-10-06 for this milestone): from the call whose work
  met it, or, when no call started the work, as an unhandled rejection.
- **FR-004** *(kernel, decided by the owner 2026-10-06 after step 1 found the defect)* A throw
  during work an embedder's call started rejects that call and leaves the session as it was before
  the call. A root `addRoot` added is removed again; a read pass whose `end()` throws leaves its
  label's previous roots in place. Later calls run normally. Today the root stays and every later
  call re-analyses it and rejects (step 1's report, finding 3).
- **FR-005** *(kernel, decided by the owner 2026-10-06)* A throw during work no call started —
  analysis set off by the host's change report — is not swallowed: it escapes as an unhandled
  rejection, which by default stops a Node process. Today `serialize` marks it handled, so the
  session silently stays at the old version with nothing said (finding 4); staying there is right,
  the silence is the defect. The queue must
  still survive for the work after it: escaping must not wedge serialization. No `onError` listener;
  that is a later addition when a long-running consumer needs one.
- **FR-006** The same two rules hold for a throw from the host (`read`, `canonicalize`) on the same
  paths, since they share `serialize`; test one of them.

## Conformance

Expected values are derived by hand or from `TextEncoder` on each prefix — never from a run of
`byteOffsets`.

| Text | Indices | Expect |
|---|---|---|
| `"\ud800ab"` (lone high, then ASCII) | `0, 1, 2, 3` | `0, 3, 4, 5` (today `0, 4, 4, 5`) |
| `"a\ud800"` (lone high at the end) | `0, 1, 2` | `0, 1, 4` |
| `"\udc00a"` (lone low) | `0, 1, 2` | `0, 3, 4` |
| `"\ud800𐀀"` (lone high, then a pair) | `0, 1, 3` | `0, 3, 7` |
| `"x😀y"` | `0, 1, 3, 4` | `0, 1, 5, 6` |
| `"x😀y"` | `2` (inside the pair) | throws (today `5`) |
| `"ab"` | `2` | `2` (the end is valid) |
| `"ab"` | `3`, `-1`, `1.5`, `NaN` | each throws (today `3` gives `5`) |
| `""` | `0` | `0` |

The existing test "agrees with TextEncoder at every index" stays and gains the lone-surrogate
texts. Through the session, with test-only handlers:
- a request whose `end` exceeds the text's length makes the triggering `addRoot` reject with the
  `RangeError` (FR-002, FR-003);
- after a rejected `addRoot`, `sources()` and the roots are as before the call, and a following
  `addRoot` of a healthy file resolves (FR-004); the same through a read pass's `end()`;
- a handler that throws on a change the host reports produces an unhandled rejection (observe it
  with a `process.on("unhandledRejection")` listener installed and removed by the test), and a
  later `addRoot` still resolves (FR-005);
- one host verb throwing behaves the same (FR-006).

**Sabotage**, each watched red and restored: drop the low-surrogate check (the first four rows go
red); drop the pair-interior check (the `x😀y` interior row goes red, and nothing else); allow
`text.length + 1` (the `"ab"` rows go red); allow non-integers (`1.5` goes red); skip the rollback (the FR-004 tests go red); restore the `catch` that swallows
(the FR-005 test goes red); make the escaping throw also break the queue (FR-005's later `addRoot`
goes red). Back up first;
mark it `SABOTAGE`; grep for it before committing.

## Parked: the findings cache (issue #3's third point)

The issue proposes keeping a version's findings only while some open session holds a source at that
version. The kernel specification's `cache-by-handler-and-hash` says "the same bytes under the same
handler are analysed **at most once**" and "No operation MUST exist to invalidate it". Evicting
breaks "at most once": a file reverted to an earlier version, or a session opened after the last
one holding that version closed, is analysed again. Doing it means amending that MUST — a decision
for the owner, not for an implementer. The growth is read from the code and not measured, and
BelType, the one consumer, loads no handlers today, so the cache serves nobody yet. **Do not touch
`src/session.ts`'s cache in this milestone.**

## Plan and tasks

One plan file is enough. Commits, tree green at each (`npm test` runs `tsc` first):

1. **The throwing-handler test** and what it showed — done (a9c98fb, report).
2. **The kernel** — FR-004, FR-005, FR-006; tests first, red against the current code.
3. **The conversion** — FR-001, FR-002, FR-003; the table above, tests first.
4. **Report** — `specs/offset-conversion/report.md`, with every place this spec or the kernel
   specification was silent or wrong.

Do not bump the version; the release is decided after verification. The kernel specification is
already amended for FR-004 and FR-005; do not edit it or `docs/` — report what should change there.
