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

**Commit.** Writing every staged edit to disk, one file at a time, each atomically. A file that no longer hashes to its base version is rebased first; a value changed on both sides is written as staged — the last to commit wins, per value — and reported. Afterwards the written versions become the base versions and the index empties. *Amended 2026-10-08 (`write-back.md`): it refused a file that had moved.* Not a version-control commit; one may follow, and that is the consumer's call. *(editing)*

**Conflicted.** The state of a staged edit whose target is gone from a source's new version after a rebase, or whose range, after a rebase, overlaps an edit staged before it (the later-staged yields). It carries its reason: `gone` (the path, or the source, is gone), `overlap`, or `unwritable` (the writer found the path but refused to write the value there again). In the first version it is dropped and reported, never blocking. *Amended 2026-10-08: a value changed on both sides is no longer conflicted; the staged edit overrides it, with a notice.* *(editing)*

**Declared.** An edge origin: the edge was found by a handler parsing a source.

**Edge.** A dependency from a place in one source to another source: `from` (the address of the span that asks), `request` (as written), `target` (a source, or unresolved), `kind` (requires or candidate), and `origin` (declared or observed).

**Edit value.** What a set edit writes: a string, a number, a big integer, a boolean or null — the same union in Provenance and Cascata, so a writer from either fits the other (`EditValue`). *(editing)*

**Edit.** A change staged against a source: either a text edit, which carries **two addresses** — an address in the base version plus the replacement bytes, and a semantic address (a path in the format's own terms, and the intended value) — or a file operation, which is create, delete or rename. *Amended 2026-10-08 (`write-back.md`): the semantic address.* *(editing)*

**Findings.** What a handler returns for one source: its requests, its regions, and optionally a base against which its requests resolve (HTML's `<base href>`).

**Group.** A set of staged edits that express one intent from a consumer, labelled, and unstaged as a unit. May be marked as needing confirmation, so one group waits for review while the rest commit. *(editing)*

**Handler.** The plugin for one language: which sources it claims, and a pure function from a source's text to its findings. It never reads, resolves, caches, watches or writes.

**Host.** Whatever supplies Provenance with everything outside the call: bytes, canonical identity, path facts, watch events and writes. It answers what is there, never what is allowed. A Node host ships as a separate entry point.

**Index.** The staged edits of a session, in groups, with a position map per touched source from its preview back to its base. *(editing)* *The first slice (`specs/editing/`) builds the index without groups or a position map: one edit per path, per source.*

**Leaf.** A source no handler parses, such as an image or a font. Addressable as a whole or by byte range, a possible edge target, and replaceable by a file operation.

**Map.** A virtual source's list of segments back to its enclosing source. A segment is linear, where offsets shift by a constant, or **opaque**, where the enclosing source escaped the text: every position inside an opaque segment maps to the whole segment, and edits there are refused.

**Observed.** An edge origin: the edge was recorded from what a runtime actually fetched. *(observation)*

**Observer.** An adapter that turns a runtime's events into observed edges. There are three kinds, by where the document renders: in the page, in a sandbox iframe, and in headless Chromium. *(observation)*

**Preview.** The base plus the index: a preview version of each touched source, with its own content hash. Analysed like any other version, and what the server shows the runtime. *(editing)*

**Probe.** A location a resolver tried while resolving a request, whether or not anything was there. A file appearing at a probe re-resolves the edge that probed it. Probes belong to the cached result of a resolution, and a cache hit re-registers them.

**Rebase.** Moving staged edits onto a source's new version when the file changes on disk: each edit asks the format plug-in to find its semantic address in the new version and to write its value there again. Found, it moves; gone, it is conflicted. *Amended 2026-10-08 (`write-back.md`): it searched for the old span's bytes with a little context, which fails exactly when the value itself changed.* *(editing)* An edit that moved keeps its status: one that overrides a value changed on disk goes on overriding it until it is staged again.

**Reconciliation.** The query that matches declared edges against observed ones and names every disagreement. It can run at any time, because observation is a window rather than a moment. *(observation)*

**Region.** Part of a source's text that belongs to another language, reported by the source's handler as a finding. Becomes a virtual source.

**Read pass.** One render's reads through the session: a Host-shaped view (`pass.host`) that records every location read, with the version of the bytes it handed out, and every location it tried and found nothing at. Ending the pass makes those locations the roots its label contributes, replacing the previous pass's. One live pass per label.

**Render manifest.** The session's record of which version of each source a render used. It is why a stamp can leave the version out. A read pass returns one when it ends: each location read, with the version the render saw, and each location found missing.

**Request.** What a source asks for, as written: `./chapter.md`, `fonts/serif.woff2`, `https://…`. Resolving a request against a base yields a target or an unresolved edge.

**Requires.** An edge kind: loading the source that asks guarantees loading the target. A Markdown include, an unconditional `@import`, an eager `img src`. An unloaded requirement is a problem.

**Resolver.** The part of Provenance that turns a request into a target, pluggable by scheme: relative paths, packages, `http(s)` (an external leaf), `data:` (no edge at all). Every resolver records its probes.

**Root.** A source a session holds because the embedder added it, or because the latest read pass with some label read it, or tried to and found nothing there, rather than because another source asked for it. A stylesheet named only in configuration is a root. The entry document is the first root.

**Session.** The unit of work: one entry document, the embedder's other roots, every source reachable from them, and one runtime observing it.

**Source.** A file Provenance knows, or a virtual source carved out of one. Has an identity Provenance mints and keeps stable, a path, a kind, and a version.

**Stage.** *Not Provenance's.* The browser projection the CSS tools build from preview versions. Provenance supplies what a stage is built from and never builds one. Its edits, however, are **staged**: held in the index, not yet committed. *The verb is Provenance's (`session.stage`); the noun is not.*

**Stamp.** An address written into rendered output as a `data-*` attribute, such as `data-src="s12:1840-1932"`: a source identity and a byte range, with the version left to the render manifest. Only a renderer can stamp; Provenance supplies the codec and helpers.

**Unresolved edge.** An edge whose request resolved to nothing. Kept in the graph with its probes, so it is visible while broken and heals when the file appears.

**URL map.** The server's statement of which URLs serve which source, preview versions included. One source may be served under several URLs. An observed URL missing from it was served by something outside the graph. *(observation)*

**Version.** The SHA-256 of a source's exact stored bytes. A new version invalidates every fact derived from the old one, by construction.

**Virtual source.** A source carved out of a region of another source, the **enclosing source**, such as a `<style>` block inside HTML. Analysed by the handler for its language, carrying a map back to its enclosing source, and resolving its requests against its enclosing source's base. The design synthesis called this the "host"; renamed because the host is the I/O supplier.
