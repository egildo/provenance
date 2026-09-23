# Glossary

**Status: draft, 2026-09-23.** One entry per christened name, and the name the code will use. A term marked *(observation)* or *(editing)* arrives with that stage; everything unmarked belongs to the kernel. [The vision](vision.md) says what arrives when.

## The word "provenance"

Three meanings sit near this project, and only one is ours.

- **Ours.** The answer to "where did this come from?", always given as an **address**. A rendered paragraph, a loaded font and a dependency all have provenance in this sense.
- **Cascata's.** Where a configuration *value* came from: its layer, its document, its span. It is compatible with ours rather than rival to it. A Cascata span counts bytes, so it is already an address once it names a version.
- **npm's.** A signed attestation of how a package was built (`npm publish --provenance`). Unrelated, and never meant here.

Written with a capital, Provenance is the library.

## Terms

**Address.** A place in a source at a known version: a source, a version, and a byte range as start and end offsets into that version's stored bytes. An omitted range means the whole source. Lines and columns are derived from an address for display and are never part of one.

**Artifact.** Something a handler exposes beside its findings, such as a PostCSS root or an mdast tree, cached by version, with positions already converted to addresses. How consumers like the CSS tools get a parse tree whose every node has an address.

**Base version.** The version of a source that staged edits refer to. Every edit in a source is expressed against its base version, never against another edit's result. *(editing)*

**Candidate.** An edge kind: loading the source that asks does not guarantee loading the target. The runtime decides. A `srcset` entry, a media-conditioned `@import`, a lazy image, nearly every `url()` in a CSS rule. An unloaded candidate is normal.

**Commit.** Writing every staged edit to disk together, after checking that each touched file still hashes to its base version. Afterwards the preview versions become the base versions and the index empties. Not a version-control commit; one may follow, and that is the consumer's call. *(editing)*

**Conflicted.** The state of a staged edit whose span could not be found, uniquely, in a source's new version after a rebase. It blocks its group until it is resolved or dropped. *(editing)*

**Declared.** An edge origin: the edge was found by a handler parsing a source.

**Edge.** A dependency from a place in one source to another source: `from` (the address of the span that asks), `request` (as written), `target` (a source, or unresolved), `kind` (requires or candidate), and `origin` (declared or observed).

**Edit.** A change staged against a source: either a text edit, which is an address in the base version plus the replacement bytes, or a file operation, which is create, delete or rename. *(editing)*

**Findings.** What a handler returns for one source: its requests, its regions, and optionally a base against which its requests resolve (HTML's `<base href>`).

**Group.** A set of staged edits that express one intent from a consumer, labelled, and unstaged as a unit. May be marked as needing confirmation, so one group waits for review while the rest commit. *(editing)*

**Handler.** The plugin for one language: which sources it claims, and a pure function from a source's text to its findings. It never reads, resolves, caches, watches or writes.

**Host.** Whatever supplies Provenance with everything outside the call: bytes, canonical identity, path facts, watch events and writes. It answers what is there, never what is allowed. A Node host ships as a separate entry point.

**Index.** The staged edits of a session, in groups, with a position map per touched source from its preview back to its base. *(editing)*

**Leaf.** A source no handler parses, such as an image or a font. Addressable as a whole or by byte range, a possible edge target, and replaceable by a file operation.

**Map.** A virtual source's list of segments back to its enclosing source. A segment is linear, where offsets shift by a constant, or **opaque**, where the enclosing source escaped the text: every position inside an opaque segment maps to the whole segment, and edits there are refused.

**Observed.** An edge origin: the edge was recorded from what a runtime actually fetched. *(observation)*

**Observer.** An adapter that turns a runtime's events into observed edges. There are three kinds, by where the document renders: in the page, in a sandbox iframe, and in headless Chromium. *(observation)*

**Preview.** The base plus the index: a preview version of each touched source, with its own content hash. Analysed like any other version, and what the server shows the runtime. *(editing)*

**Probe.** A location a resolver tried while resolving a request, whether or not anything was there. A file appearing at a probe re-resolves the edge that probed it. Probes belong to the cached result of a resolution, and a cache hit re-registers them.

**Rebase.** Moving staged edits onto a source's new version when the file changes on disk: each edit looks for its original span's bytes, with a little context, in the new version. A unique match moves it; anything else marks it conflicted. *(editing)*

**Reconciliation.** The query that matches declared edges against observed ones and names every disagreement. It can run at any time, because observation is a window rather than a moment. *(observation)*

**Region.** Part of a source's text that belongs to another language, reported by the source's handler as a finding. Becomes a virtual source.

**Render manifest.** The session's record of which version of each source a render used. It is why a stamp can leave the version out.

**Request.** What a source asks for, as written: `./chapter.md`, `fonts/serif.woff2`, `https://…`. Resolving a request against a base yields a target or an unresolved edge.

**Requires.** An edge kind: loading the source that asks guarantees loading the target. A Markdown include, an unconditional `@import`, an eager `img src`. An unloaded requirement is a problem.

**Resolver.** The part of Provenance that turns a request into a target, pluggable by scheme: relative paths, packages, `http(s)` (an external leaf), `data:` (no edge at all). Every resolver records its probes.

**Session.** The unit of work: one entry document, every source reachable from it, and one runtime observing it.

**Source.** A file Provenance knows, or a virtual source carved out of one. Has an identity Provenance mints and keeps stable, a path, a kind, and a version.

**Stage.** *Not Provenance's.* The browser projection the CSS tools build from preview versions. Provenance supplies what a stage is built from and never builds one. Its edits, however, are **staged**: held in the index, not yet committed.

**Stamp.** An address written into rendered output as a `data-*` attribute, such as `data-src="s12:1840-1932"`: a source identity and a byte range, with the version left to the render manifest. Only a renderer can stamp; Provenance supplies the codec and helpers.

**Unresolved edge.** An edge whose request resolved to nothing. Kept in the graph with its probes, so it is visible while broken and heals when the file appears.

**URL map.** The server's statement of which URLs serve which source, preview versions included. One source may be served under several URLs. An observed URL missing from it was served by something outside the graph. *(observation)*

**Version.** The SHA-256 of a source's exact stored bytes. A new version invalidates every fact derived from the old one, by construction.

**Virtual source.** A source carved out of a region of another source, the **enclosing source**, such as a `<style>` block inside HTML. Analysed by the handler for its language, carrying a map back to its enclosing source, and resolving its requests against its enclosing source's base. The design synthesis called this the "host"; renamed because the host is the I/O supplier.
