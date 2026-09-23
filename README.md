# Provenance

A library that knows, for one rendered document, every source file involved, how those files depend on each other, where each rendered thing came from, and how to write changes back to disk. It runs in any JavaScript realm: it performs no I/O of its own and asks a host for everything outside the call.

**Status: the kernel is built; observation and editing are not.** A session finds every source reachable from an entry document and its roots, records each declared dependency against the exact bytes that asked for it, keeps broken references visible until they heal, and reports what changed as files change. See [the kernel spec](specs/source-graph-kernel/spec.md) for what that covers and what it leaves out.

```ts
import { openSession } from "@egildo/provenance";
import { createNodeHost } from "@egildo/provenance/node";
import { css } from "@egildo/provenance/css";
import { html } from "@egildo/provenance/html";

const session = await openSession({
  host: createNodeHost(),
  entry: "/path/to/index.html",
  handlers: [html, css],
});
for (const source of session.sources()) console.log(source.id, source.state, source.location);
session.onChange(change => console.log(change));
```

Node 22.18 or later. `npm test` type-checks and runs the tests; `npm run build` writes `dist/`. Every export is listed in [the public API contract](specs/source-graph-kernel/contracts/public-api.md).

- [Vision](docs/vision.md): what it is for, who it serves, what it is not.
- [Design principles](docs/principles.md): how it decides things, each principle with what it forbids.
- [Glossary](docs/glossary.md): every christened name, and which meaning of "provenance" is ours.
- [Design synthesis](docs/design-synthesis.md): the day-zero design the vision was drawn from.
