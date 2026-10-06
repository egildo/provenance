<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="Provenance" width="360">
  </picture>
</p>

<p align="center">
  <strong>Every byte of rendered output, traced back to the exact file, version, and byte range that produced it.</strong>
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-0.3.0-blue">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="status" src="https://img.shields.io/badge/status-kernel%20built-orange">
</p>

---

A rendered document is made of many files. By the time a page appears in a browser, it has read
an include tree, a configuration cascade, stylesheets, fonts, images, and whatever plugins pulled
in along the way. Two questions follow every render: **what did it actually load**, and **which
files must change on disk** when someone edits what they see.

Provenance is one structure that answers both. For a single rendered document, it knows every
source involved, how those sources depend on each other, where each rendered thing came from, and
how to stage and write changes back — without ever touching a filesystem itself.

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

for (const source of session.sources()) {
  console.log(source.id, source.state, source.location);
}

session.onChange(change => console.log(change));
```

## Why

Most tools that need this answer it twice, with bookkeeping that can't talk to itself. BelType —
the project Provenance was extracted from — kept a list of files read, a separate list of URLs
loaded, two near-identical file watchers, and one hand-rolled rule mapping URLs back to files.
Each piece answered one question. None of them could answer the other, because they shared no
coordinates.

Provenance gives every fact — an edge, a stamp, an edit — one coordinate system: a source, a
version, and a byte range. Anything it knows can be joined against anything else it knows.

## What it does

- **Tracks sources of any kind.** Markdown, HTML, CSS, configuration, images, fonts — and
  whatever a handler teaches it. Binary files are leaves: addressable, never parsed.
- **Records dependencies twice.** *Declared* edges come from parsing; *observed* edges come from
  what a runtime actually fetched. The two are kept apart on purpose — the gap between them is
  the product, not noise to smooth over.
- **Addresses rendered output.** Any rendered node can point back to the exact source, version,
  and byte range that produced it.
- **Stages edits.** Changes are held against a base version, previewed in memory, and written to
  disk together. What gets written is exactly what the preview showed.

It runs in any JavaScript realm — Node, a browser tab, a worker — because it performs **no I/O of
its own**. Everything outside the call (reading, writing, watching, path arithmetic) is asked of a
**host** the embedder supplies. A Node host ships as its own entry point; nothing else in the
library imports from `node:`, and a test enforces that rather than trusting convention.

## How it decides things

Provenance is opinionated on purpose. Nine design principles govern it, each one stated as
something it refuses to do:

| Principle | Forbids |
|---|---|
| **One address space** | A fact with no address. A second coordinate system past the handler boundary. |
| **Handlers declare; Provenance decides** | A handler that reads, resolves, caches, watches, or writes. |
| **Derived facts are pure functions of versions** | Any `invalidate()` call, anywhere. A cache hit that skips re-registering its probes. |
| **Declared and observed stay apart** | An observation that overwrites a declared edge. A disagreement smoothed away. |
| **Source is the stored reality; renders are projections** | Writing Provenance's own bookkeeping into a source file. |
| **Nothing touches disk before commit** | Any write outside commit. A staged edit expressed against another staged edit's result. |
| **Edits are splices** | A printer or serializer that regenerates a source from a tree. |
| **Languages are plugins; nesting is delegation** | Language knowledge in the core. A handler parsing another language's region itself. |
| **Supply, not meaning** | A `node:` import outside the Node host. A host that returns a verdict instead of a fact. |

The full reasoning — with the incidents each rule was cut from — is in
[the design principles](docs/principles.md).

## Status

**The kernel is built. Observation and editing are not.**

A session finds every source reachable from an entry document and its roots, records each
declared dependency against the exact bytes that asked for it, keeps broken references visible
until they heal, and reports what changed as files change. See
[the kernel spec](specs/source-graph-kernel/spec.md) for exactly what that covers, and
[the changelog](CHANGELOG.md) for what shipped in each release.

What's next, in order: **observation** (reconciling declared edges against what a runtime
actually fetched) and **editing** (staged edits, previews, commits) — see
[the vision's "What arrives first"](docs/vision.md#what-arrives-first).

## Install

Provenance publishes to GitHub Packages, not the public npm registry. Point npm at it in
`.npmrc`:

```
@egildo:registry=https://npm.pkg.github.com
```

```bash
npm install @egildo/provenance
```

Requires Node 22 or later (22.18+ to run the tests from source, for type stripping).

## Entry points

| Import | What it gives you |
|---|---|
| `@egildo/provenance` | `openSession` and the core types |
| `@egildo/provenance/html` | An HTML handler, on [parse5](https://github.com/inikulin/parse5) |
| `@egildo/provenance/css` | A CSS handler, on [PostCSS](https://postcss.org/) |
| `@egildo/provenance/node` | The Node host |
| `@egildo/provenance/memory` | An in-memory host, for any realm — tests, browsers, workers |

Every export is listed in [the public API contract](specs/source-graph-kernel/contracts/public-api.md).

## Who it's for

- **BelType**, first — replacing its file list, URL list, two watchers, and eventually its
  editing server's write path.
- **Cascata**, by shape and not by import — a read pass's host satisfies Cascata's `Host`
  interface structurally, so Cascata's configuration files become session roots without Cascata
  ever importing Provenance.
- **The CSS tools**, which build on Provenance's addresses and its edit model.
- **Any tool** that renders documents from files and needs to know what it read, what the runtime
  loaded, and how to write back.

What it deliberately stays out of — rendering, transforming, reading meaning, serving, history —
is in [the vision's "What it is not"](docs/vision.md#what-it-is-not), each exclusion argued for.

## Documentation

- **[Vision](docs/vision.md)** — what Provenance is for, who it serves, what it refuses to be.
- **[Design principles](docs/principles.md)** — how it decides things, each rule with what it forbids.
- **[Glossary](docs/glossary.md)** — every christened term, and which meaning of "provenance" is ours.
- **[Design synthesis](docs/design-synthesis.md)** — the day-zero design the vision was drawn from.
- **[Kernel spec](specs/source-graph-kernel/spec.md)** and **[read-passes spec](specs/read-passes/spec.md)** — what's built, precisely.

## Development

```bash
npm test    # type-checks and runs the tests
npm run build   # writes dist/
```

## License

[MIT](LICENSE)
