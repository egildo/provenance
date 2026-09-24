# Changelog

## 0.2.0 — 2026-09-24

Published as `@egildo/provenance` on GitHub Packages.

- **Breaking:** `session.host` is gone. Reads become roots through a **read pass** instead ([spec](specs/read-passes/spec.md), [#1](https://github.com/egildo/provenance/issues/1)): `session.read(label)` returns a pass whose Cascata-shaped `host` records every read, with the version of the bytes it handed out, and every location it found nothing at; `pass.note(location)` records code read outside it; `pass.end()` makes those locations the label's roots, replacing the previous pass's, settles once, and returns the render manifest. A file appearing where a render found nothing is reported as a change, and a file the next render stops reading leaves.

## 0.1.0 — 2026-09-23

Published as `@egildo/provenance` on GitHub Packages.

- The source graph kernel ([spec](specs/source-graph-kernel/spec.md)): sessions over an entry document and its roots, byte addresses, declared edges with their probes, analysis to a fixpoint cached by handler and content hash, and change batches reported once.
- Five entry points: `@egildo/provenance` (`openSession` and the types), `/css` (a CSS handler on PostCSS), `/html` (an HTML handler on parse5), `/memory` (an in-memory host for any realm), `/node` (the Node host).
- `close()` is final: work queued or running when it is called never watches again, so a Node host no longer keeps the process alive.
- A root-absolute base (`<base href="/">`) is a URL path, never a directory: relative requests join it and resolve as root-absolute requests, which are the embedder's. A protocol-relative base is the web.
