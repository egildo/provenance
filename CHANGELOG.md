# Changelog

## 0.1.0 — 2026-09-23

Published as `@egildo/provenance` on GitHub Packages.

- The source graph kernel ([spec](specs/source-graph-kernel/spec.md)): sessions over an entry document and its roots, byte addresses, declared edges with their probes, analysis to a fixpoint cached by handler and content hash, and change batches reported once.
- Five entry points: `@egildo/provenance` (`openSession` and the types), `/css` (a CSS handler on PostCSS), `/html` (an HTML handler on parse5), `/memory` (an in-memory host for any realm), `/node` (the Node host).
- `close()` is final: work queued or running when it is called never watches again, so a Node host no longer keeps the process alive.
- A root-absolute base (`<base href="/">`) is a URL path, never a directory: relative requests join it and resolve as root-absolute requests, which are the embedder's. A protocol-relative base is the web.
