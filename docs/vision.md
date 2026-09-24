# Vision

**Status: draft, 2026-09-23.** Nothing here is built. The library is called **Provenance**; it was designed as "the source graph", and the graph is still what it holds. The bare name is taken on npm, so it publishes as `@egildo/provenance`. This document is normative on *what the library is and what it is for*; the design principles are normative on *how it is built*. When the two collide, this document wins on scope and the principles win on method.

## The problem

A rendered document is made of many files. BelType renders a Markdown file, and by the time a page appears in the browser it has read an include tree, a configuration cascade, parameter files, plugins, stylesheets, fonts and images. Two questions follow every render: *what did the browser actually load*, and *which files must change on disk* when someone edits what they see. Today each is answered by separate bookkeeping. BelType keeps a list of files read and a list of URLs loaded, two near-identical file watchers, one rule mapping URLs to files, and a write path in its editing server. Each was built to answer one of those questions, and none of them can answer the other.

Provenance is one structure that answers both. For one rendered document it knows every source involved, how the sources depend on each other, where each rendered thing came from, and how to write changes back.

## What it does

Four jobs, all stated against one address space.

- **Tracks sources of any kind.** Markdown, HTML, CSS, configuration, images, fonts, and whatever a handler teaches it. Binary files are leaves: addressable, never parsed.
- **Records dependencies twice.** *Declared* dependencies are found by parsing; *observed* dependencies are seen at runtime. The two are kept apart and the library reports where they disagree. The gap between them is the product, not noise to smooth over.
- **Addresses rendered output.** Any rendered node can say which source, at which version, and which byte range produced it.
- **Stages edits.** Changes are held against a base version, previewed in memory, and written to disk together. What gets written is exactly what the preview showed.

The unit of work is a **session**: one entry document, the other roots the embedder adds or its renders read, everything reachable from them, and one runtime observing it. Roots exist because not everything a render reads is asked for by a source: a stylesheet or a plugin named in configuration, and the configuration files themselves, are reached by meaning, which is the embedder's (amended 2026-09-23, from the kernel spec). A render's reads become roots through a **read pass**, and the next render's pass replaces them, so what a render stops reading leaves (amended 2026-09-24, from [the read-passes spec](../specs/read-passes/spec.md)).

## The address space is bytes

**Settled, 2026-09-23.** An address is a source, a version, and a range of **byte offsets** into that version's stored bytes. A version is the SHA-256 of those exact bytes.

The design synthesis had chosen UTF-16 code units, JavaScript's native string index, so that a range would index straight into loaded text. It was reversed when the first real customer was checked. Cascata's spans count bytes, because its pins hash exact bytes, and a Cascata span crossing into a UTF-16 graph would need converting against the text at every crossing. That makes two address spaces joined by a converter, which is exactly what "one address space" exists to forbid.

Bytes also fit everything else the library promises. The commit guarantees are byte guarantees: the bytes written equal the preview's bytes, and a byte diff between base and committed file touches only staged ranges. A byte range means something in a font or an image, where a string index does not. And a version hash is computed over bytes anyway.

The cost is real and lands in one place. Parsers hand back string indices, so each handler's findings must be converted from string indices to bytes. That conversion happens exactly once, at the handler boundary, and never downstream. Cascata learned this trap the hard way: its YAML parser reports UTF-16 indices, the two agree on ASCII, and an ASCII-only probe missed the difference entirely. The conversion is tested against non-ASCII input or it is not tested.

## Where it runs

Anywhere JavaScript runs: a Node server, a browser tab, a worker. It gets there the way Cascata did. **The library performs no I/O.** Reading, writing, renaming, watching, canonical identity and path arithmetic are all asked of a **host**, which the embedder supplies. A Node host ships as a separate entry point. No module outside it imports anything from `node:`, and a test enforces that rather than a convention.

This is not a preference. Cascata imported `node:path`, `node:os` and `node:crypto` inside the library proper, and the result was not a missing feature in the browser. The whole library failed at module evaluation, before a line of its own code ran.

## Who it serves

- **BelType, first.** Provenance replaces its file list, its URL list, its two watchers, and eventually its editing server's write path. BelType keeps what is BelType's: the include syntax and its keyscope, rendering, stamping, the server, and the decision of when to commit.
- **Cascata, by shape and not by import.** Cascata already reads only through a host it is given. A read pass's host satisfies Cascata's `Host` interface structurally, so every configuration file Cascata reads becomes a root of the session without Cascata importing Provenance or knowing it exists. This is the only honest way to take Cascata's dependencies. Whether `./values.yaml` in a config is a file to load or data about a file depends on the schema, so no handler reading that one file could find its edges; Cascata answers them for the whole cascade at once.
- **The CSS tools**, the companion design, which build on Provenance's addresses and its edit model.
- **Any tool** that renders documents from files and needs to know what it read, what the runtime loaded, and how to write back.

## What it is not

Each exclusion is load-bearing, and each names what adding it back would cost.

- **Not a renderer or a transformer.** BelType turns Markdown into HTML; Provenance analyses, addresses and watches. Adding transformation back turns Provenance into a bundler, and every handler into a compiler.
- **Not a reader of meaning.** Provenance knows spans, not what they mean. Cascade reasoning belongs to the CSS tools; configuration meaning belongs to Cascata; include precedence belongs to BelType. Adding meaning back makes Provenance a second authority on questions those libraries already own, and two authorities can disagree.
- **Not a doer of I/O.** Everything outside the call is asked of the host. Adding I/O back costs every realm but one.
- **Not a history.** Git keeps history. Commit here means writing files; a version-control commit may follow, and that is the consumer's call. Adding history back means reimplementing the index of a tool everyone already has.
- **Not a server.** The server serves files and tells Provenance which URLs serve which source. Adding serving back means owning routing, caching headers and previews, all of which the embedder already has opinions about.
- **Not a reader of scripts, in its first version.** Scripts are opaque to analysis; whatever they fetch shows up as observed and undeclared. Adding a script handler back means static analysis of JavaScript, which is a project of its own.

## What arrives first

The whole vision is not the first build. The kernel comes first: sources, addresses, edges, the handler contract, analysis to a fixpoint with probes, and the host. It is proven when BelType's file list, URL list and two watchers are replaced by it. Observation and editing follow, in that order, each proven the same way against the BelType code it replaces.

## Open, and deliberately left open here

- **Text that is not UTF-8.** Addresses are over stored bytes, so a byte-order mark is simply the first bytes of the file. How a handler receives non-UTF-8 text, and how the commit guarantees hold through decode and re-encode, is not decided.
- **Edits inside escaped text**, such as an HTML entity in a `style` attribute: refused in the first version, or re-escaped by the enclosing source's handler.
- **Multi-file atomicity**: best-effort renames with rollback, or a small journal.

The [design synthesis](design-synthesis.md) of 2026-09-22 carries the rest of the open questions, and [the design principles](principles.md) carry the rules. Neither is restated here.
