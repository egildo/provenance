# Changelog

## 0.4.0 — 2026-10-08

A minor release because a kernel promise changes: the same bytes can now be analysed more than once ([spec](specs/held-versions/spec.md), [#3](https://github.com/egildo/provenance/issues/3)).

- **Findings live while a session holds them.** The findings cache used to keep every version of every source for as long as its handler lived, so a server watching files for days grew without bound. A finding now lives while some open session holds that version — in its graph, or in a piece of work still running — and is dropped when the last piece of work that held it ends or its session closes. Two open sessions still share one analysis. Returning a file to a version nobody holds any more analyses it again.
- **A failed `openSession` no longer leaks its file watcher.** It closes what it opened.
- Nothing is added to the API; nothing an embedder calls evicts, pins or sizes the cache.

## 0.3.0 — 2026-10-06

A minor release because two observable behaviours change ([spec](specs/offset-conversion/spec.md), [#3](https://github.com/egildo/provenance/issues/3)).

- **A failed call changes nothing.** When a handler or the host throws during work an embedder's call started (`openSession`, `addRoot`, `removeRoot`, a read pass's `end()`), the call rejects and the session is left exactly as it was before it: roots, sources and links. Before, a root that failed stayed, and every later call re-analysed it and failed again.
- **A throw nobody called for escapes.** When a handler or the host throws during work a change report set off, the error is no longer swallowed: it escapes as an unhandled rejection, which by default stops a Node process. The session stays at its last good state. Before, it went on silently showing the old version.
- **Listeners run after the work is kept.** A change listener that throws no longer undoes the session's work; every other listener is still told, and the first throw is the one raised.
- `byteOffsets` counts a lone high surrogate as the three bytes `TextEncoder` writes for it, and throws a `RangeError` for an index it cannot convert: not an integer, negative, past the end, or inside a surrogate pair. Neither is reachable through the shipped handlers.
- Not in this release: evicting old versions from the findings cache. It conflicts with the kernel rule that the same bytes are analysed at most once, and is parked.

## 0.2.1 — 2026-09-28

- README rewritten as a proper repo front page, with the design principles tabled and an honest status section. MIT `LICENSE` file added to back `package.json`'s declared license. No code changes.

## 0.2.0 — 2026-09-24

Published as `@egildo/provenance` on GitHub Packages.

- **Breaking:** `session.host` is gone. Reads become roots through a **read pass** instead ([spec](specs/read-passes/spec.md), [#1](https://github.com/egildo/provenance/issues/1)): `session.read(label)` returns a pass whose Cascata-shaped `host` records every read, with the version of the bytes it handed out, and every location it found nothing at; `pass.note(location)` records code read outside it; `pass.end()` makes those locations the label's roots, replacing the previous pass's, settles once, and returns the render manifest. A file appearing where a render found nothing is reported as a change, and a file the next render stops reading leaves.

## 0.1.0 — 2026-09-23

Published as `@egildo/provenance` on GitHub Packages.

- The source graph kernel ([spec](specs/source-graph-kernel/spec.md)): sessions over an entry document and its roots, byte addresses, declared edges with their probes, analysis to a fixpoint cached by handler and content hash, and change batches reported once.
- Five entry points: `@egildo/provenance` (`openSession` and the types), `/css` (a CSS handler on PostCSS), `/html` (an HTML handler on parse5), `/memory` (an in-memory host for any realm), `/node` (the Node host).
- `close()` is final: work queued or running when it is called never watches again, so a Node host no longer keeps the process alive.
- A root-absolute base (`<base href="/">`) is a URL path, never a directory: relative requests join it and resolve as root-absolute requests, which are the embedder's. A protocol-relative base is the web.
