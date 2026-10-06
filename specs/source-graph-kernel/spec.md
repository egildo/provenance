# Feature Specification: Source graph kernel

**Feature Branch**: `source-graph-kernel`

**Created**: 2026-09-23

**Status**: Draft

**Input**: User description: "The Provenance kernel, the first build named in docs/vision.md "What arrives first": sources (files and leaves), addresses (source, version as SHA-256 of stored bytes, byte range), edges (declared origin only; requires and candidate kinds; unresolved edges kept with their probes), the handler contract (pure function from a source's text to findings, with string indices converted to byte offsets once at the handler boundary), resolvers that record probes, analysis of a session from one entry document to a fixpoint with caching by handler and content hash, and the host contract (all I/O supplied by the embedder, with an in-memory host and a Node host as a separate entry point). It is proven when it can replace BelType's file list, URL list and two watchers. Observation, reconciliation, regions and virtual sources, and editing are out of scope for this feature."

This is the kernel named in [the vision](../../docs/vision.md) under *What arrives first*. Terms
are used as [the glossary](../../docs/glossary.md) defines them, and design rules are cited by
their names in [the design principles](../../docs/principles.md); neither is restated here.

**Out of scope, and arriving later:** observation, the URL map and reconciliation; regions and
virtual sources; edits, the index, preview and commit; stamps and the render manifest; package
resolution. BelType's rule mapping URLs to files stays in BelType until the URL map arrives with
observation.

**The proof.** BelType keeps two lists and two watchers today (surveyed 2026-09-23 in the BelType
repository):

- the **file list**, `readSet` (`packages/core/src/pipeline.js`), filled from the configuration
  cascade, the include tree, parameters files and plugin modules;
- the **URL list**, `closure.entries` (`packages/core/src/closure.js`), filled by *parsing*
  BelType's own emitted HTML, CSS and JavaScript, not by watching the browser;
- **two watchers**, `packages/cli/src/watcher.js` and `packages/editing-tools/src/watcher.js`,
  near-copies of each other, whose events are sorted into "rebuild" or "reload" by their callers.

Because the URL list is parsed rather than observed, declared edges can replace it without
observation.

## User Scenarios & Testing *(mandatory)*

The user of this feature is an **embedder**: a tool that renders documents from files, BelType
first. It supplies a host and handlers, opens a session on an entry document, and reads the graph.

### User Story 1 - Know every source a document depends on (Priority: P1)

An embedder opens a session on one entry document and gets back every source reachable from it,
and every declared edge between them, each edge pointing at the exact bytes that asked.

**Why this priority**: this is the file list and the URL list in one structure. Nothing else in
the kernel matters until it exists.

**Independent Test**: with an in-memory host holding a small tree and two small test handlers,
open a session and compare its sources and edges with the expected ones, byte for byte.

**Acceptance Scenarios**:

1. **Given** `a.md` includes `b.md`, which includes `c.md`, **When** a session opens on `a.md`,
   **Then** it holds exactly the sources `a.md`, `b.md`, `c.md` and two `requires` edges, and each
   edge's `from` range slices the stored bytes to exactly the request as written.
2. **Given** a stylesheet whose `url()` names `serif.woff2`, **When** the session is analysed,
   **Then** `serif.woff2` is a leaf with a `candidate` edge into it, and its bytes are never
   decoded or passed to a handler.
3. **Given** a request preceded on its line by `café ✓ 𝄞`, **When** the session is analysed,
   **Then** the edge's range counts bytes of the stored UTF-8, not string indices.
4. **Given** `a.md` includes `b.md` and `b.md` includes `a.md`, **When** the session is analysed,
   **Then** both edges are recorded, the cycle is reported, and analysis ends.
5. **Given** a stylesheet named only in configuration, **When** the embedder adds it as a root,
   **Then** it and the font it asks for are sources of the session; **When** the root is removed
   and nothing else reaches them, **Then** both leave.

---

### User Story 2 - Broken references stay visible and heal (Priority: P1)

A reference to a file that does not exist is kept in the graph as an unresolved edge with the
locations its resolver tried. When a file appears at one of them, the edge heals by itself.

**Why this priority**: a broken include must stay visible while broken and heal without a
restart. It is *Broken is a state, not an exception*, and it is also what makes the probes needed
by story 3 exist at all.

**Independent Test**: in an in-memory host, include a missing file, then create it through the
host and check that the edge resolves and the new file is analysed.

**Acceptance Scenarios**:

1. **Given** `a.md` includes `missing.md`, **When** the session opens, **Then** nothing throws,
   the edge is unresolved, and it lists the probes its resolution made.
2. **Given** that unresolved edge, **When** the host reports `missing.md` created at a probed
   location, **Then** the edge resolves, `missing.md` is analysed, and no other source is
   re-analysed.
3. **Given** a read the host refuses (for example, permission denied), **When** the session is
   analysed, **Then** the source is recorded with the host's reason and nothing throws.

---

### User Story 3 - Stay current as files change (Priority: P2)

The embedder receives one stream of changes from the session, saying which sources were added,
removed or given a new version, and decides from it whether to rebuild or reload. This replaces
BelType's two watchers.

**Why this priority**: it completes the proof, but it needs stories 1 and 2 first.

**Independent Test**: script a sequence of file changes through the in-memory host and check each
reported change and each count of handler calls.

**Acceptance Scenarios**:

1. **Given** an open session, **When** the host reports `b.md` changed, **Then** only `b.md` is
   re-analysed, its edges are re-resolved, and the change report names `b.md` with its new
   version.
2. **Given** a file rewritten with identical bytes, **When** the host reports the change, **Then**
   no new version is produced and no change is reported.
3. **Given** `b.md` edited so that it no longer includes `c.md`, **When** the change is absorbed,
   **Then** `c.md` leaves the session, is reported removed, and is no longer watched.
4. **Given** two sources with identical bytes claimed by one handler, **When** both are analysed,
   **Then** the handler runs once, and the cache hit still registers its probes.

---

### User Story 4 - Run in any JavaScript realm (Priority: P2)

The same kernel runs in Node, a browser tab or a worker, because it performs no I/O itself. An
in-memory host ships for any realm; a Node host ships as a separate entry point.

**Why this priority**: *Supply, not meaning* is a founding constraint; getting it wrong later
costs every realm but one.

**Independent Test**: the acceptance suite of stories 1 to 3 runs against the in-memory host and
against the Node host on a temporary directory, and a test fails if library code outside the Node
host imports a platform module.

**Acceptance Scenarios**:

1. **Given** the library loaded in a browser, **When** a session opens against an in-memory host,
   **Then** it behaves as it does in Node.
2. **Given** an editor that saves by writing a temporary file and renaming it, **When** the Node
   host observes the save, **Then** the session receives one change, not a deletion and a
   creation.
3. **Given** Cascata reading configuration through the session's host, **When** it loads a
   cascade, **Then** every file it read is a root of the session, and Cascata imports nothing
   from Provenance.

---

### Edge Cases

- A request with a `data:` scheme produces no edge; an `http(s)` request is an external leaf,
  never read.
- One file reached by two spellings (`./a/../b.md`, a symlink) is one source when the host says
  the two are the same.
- A source no handler claims is a leaf, whatever its extension.
- A claimed source whose bytes are not valid UTF-8 is not passed to its handler (see
  `undecodable-text-is-a-state`).
- A byte-order mark is the first bytes of the source; offsets count it.
- One source asking twice for the same target yields two edges, told apart by their `from`.
- A deleted source turns every edge into it unresolved, with probes, and leaves the session if
  nothing else reaches it.
- The entry document itself missing is an unresolved entry, reported, not thrown.

## Requirements *(mandatory)*

### Functional Requirements

**Sources and addresses**

- **`address-by-bytes`**: Every address MUST name a source, a version, and optionally a start and
  end byte offset into that version's stored bytes. Lines and columns MUST NOT be stored.
- **`version-is-content-hash`**: A source's version MUST be the SHA-256 of its exact stored bytes,
  so identical bytes have the same version whatever their path or time.
- **`stable-source-identity`**: Provenance MUST mint each source an identity that stays the same
  across its versions for the life of the session, and MUST treat locations the host reports as
  canonically equal as one source.
- **`leaves-are-never-parsed`**: A source no registered handler claims MUST be a leaf:
  addressable, a possible edge target, and never decoded or passed to a handler.

**Handlers**

- **`handler-returns-findings`**: A handler MUST be a pure function from one source's text to its
  findings: requests (range, request as written, kind) and optionally a base and artifacts. It
  MUST be given no means to read, resolve, cache, watch or write.
- **`one-handler-per-source`**: Each source MUST be analysed by at most one handler. When several
  claim it, the embedder's registration order decides.
- **`convert-offsets-at-boundary`**: String indices in a handler's findings MUST be converted to
  byte offsets once, where the findings are received. No string index MUST travel further. The
  conversion MUST be tested on text with multi-byte and astral characters before the request.
- **`undecodable-text-is-a-state`**: A claimed source whose bytes are not valid UTF-8 MUST NOT be
  passed to its handler; it MUST be reported and stay addressable by bytes. *Phase:* this settles
  the kernel only; how later stages decode and round-trip non-UTF-8 text stays open in the vision.
- **`ship-css-handler`**: A CSS handler MUST ship, declaring `@import`, `url()`, `image-set()` and
  `@font-face` `src`, each with its kind as the glossary defines `requires` and `candidate`: an
  unconditional `@import` requires its target, a conditioned one is a candidate, and every `url()`
  in a rule is a candidate.
- **`ship-html-handler`**: An HTML handler MUST ship, declaring `link href`, `img src` and
  `srcset`, `source`, `video` and `audio`, `iframe`, `object`, SVG `use href` and `script src`,
  and reporting `<base href>` as its base. *Phase:* `<style>` blocks and `style` attributes are
  regions and wait for them.
- **`pay-for-loaded-handlers`**: An embedder that does not load a shipped handler MUST NOT load
  that handler's parser.

**Edges and resolution**

- **`edges-carry-origin-and-kind`**: Every edge MUST record `from`, `request`, `target` (a source
  or unresolved), `kind` (`requires` or `candidate`) and `origin`. In this feature every edge's
  origin is `declared`.
- **`resolve-by-scheme`**: Resolution MUST be chosen by the request's scheme. The kernel MUST
  resolve relative paths against the source's location or the base its handler reported, make
  `http(s)` requests external leaves that are never read, and make `data:` requests no edge.
- **`every-resolver-records-probes`**: Every resolver MUST record each location it tried, whether
  or not anything was there.
- **`keep-unresolved-edges`**: An edge whose request resolves nowhere MUST stay in the graph, with
  its probes.
- **`probes-heal-edges`**: When the host reports a file appearing at a probed location, every edge
  that probed it MUST be re-resolved, and a newly reachable target MUST be analysed.

**Sessions and analysis**

- **`embedder-adds-roots`**: A session MUST have one entry document, and the embedder MUST be able
  to add and remove further **roots**: sources the entry never asks for, such as stylesheets and
  plugins named in configuration. Every file read through the session's host by someone other
  than Provenance, such as Cascata, MUST become a root. *Superseded 2026-09-24 in its last
  sentence by [`read-passes/end-replaces-predecessor`](../read-passes/spec.md): reads become roots
  through a read pass, and a pass's roots are replaced by the next pass.*
- **`analyse-to-fixpoint`**: Opening a session MUST analyse its roots, the entry among them, and
  every source reachable from them through resolved edges, and stop when nothing new appears.
- **`record-cycles-never-follow`**: A cycle MUST be recorded as edges and reported, and analysis
  MUST terminate.
- **`query-the-graph`**: A session MUST answer: every source with its version and state; the
  edges out of and into a source; every unresolved edge; every cycle.
- **`broken-is-reported-not-thrown`**: A missing file, a refused read, an unresolvable request,
  undecodable text and a cycle MUST be reported as state and never thrown. Invalid arguments and a
  handler that throws are programmer errors and MUST throw. *Amended 2026-10-06
  (`specs/offset-conversion/`): where it throws to.* A throw during work an embedder's call
  started MUST reject that call and MUST leave the session as it was before the call — a root the
  call added, or the roots a read pass's `end()` installed, are rolled back. A throw during work no
  call started — analysis the host's change report set off — MUST NOT be swallowed: it escapes as
  an unhandled rejection. A session MUST NOT go on showing a source as analysed at a version whose
  analysis threw.

**Caching and change**

- **`cache-by-handler-and-hash`**: Analysis MUST be cached by handler and version, so the same
  bytes under the same handler are analysed at most once. No operation MUST exist to invalidate
  it.
- **`cache-hit-reregisters-probes`**: A cache hit MUST register the probes of the result it
  replays, exactly as a fresh analysis would.
- **`reanalyse-only-what-changed`**: When the host reports a change, Provenance MUST re-read that
  source only, and re-analyse it only if its version changed; then re-resolve its edges and every
  edge whose probes the change touched. No other source MUST be re-analysed.
- **`drop-unreachable-sources`**: A source no longer reachable from the session's roots MUST leave
  the session and stop being watched.
- **`report-changes`**: After absorbing a batch of host events, the session MUST report which
  sources were added, removed or given a new version, once per batch.

**Hosts**

- **`all-io-through-host`**: Every read, canonical-identity question, path computation and watch
  MUST go through the host. Library code outside the Node host MUST import no platform module,
  and a test MUST enforce it.
- **`host-answers-facts`**: A host MUST answer with facts (bytes or a refusal with its reason; a
  canonical identity or "unknown"; change events), never with verdicts about what is allowed.
- **`host-fits-cascata`**: The session's host MUST satisfy Cascata's host contract by shape, so
  every file Cascata reads through it becomes a source of the session. *Phase:* reading and
  canonical identity now; Cascata's cache operations when a consumer needs them. *Superseded
  2026-09-24 by [`read-passes/pass-host-is-cascata-shaped`](../read-passes/spec.md): the session
  has no host of its own; each read pass has one.*
- **`ship-memory-host`**: An in-memory host MUST ship for every realm, able to create, change,
  delete and refuse files on demand.
- **`ship-node-host`**: A Node host MUST ship as a separate entry point, reading, canonicalizing
  and watching the real file system, and reporting a write-then-rename save as one change.

### Key Entities *(include if feature involves data)*

Each is defined in [the glossary](../../docs/glossary.md); only the kernel's scope is noted here.

- **Session**: one entry document, the embedder's other roots, and every source reachable from
  them; the unit the embedder opens.
- **Root**: a source the session holds because the embedder or a host read put it there, not
  because another source asked for it.
- **Source**: a file or a leaf. No virtual sources yet.
- **Address**: source, version, byte range.
- **Edge**: declared only, `requires` or `candidate`, resolved or unresolved.
- **Handler** and **Findings**: requests and a base; no regions yet. The CSS and HTML handlers
  ship; the Markdown include handler is BelType's.
- **Resolver** and **Probe**: relative paths, `http(s)` and `data:`.
- **Host**: the in-memory host and the Node host.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **`replaces-beltype-lists`**: On BelType's example documents, the session's sources equal the
  union of BelType's file list and the local entries of its URL list, with every difference
  explained by a named out-of-scope item and none unexplained.
- **`replaces-beltype-watchers`**: BelType runs on one change stream from the session instead of
  its two watchers, and across a scripted set of edits (an include, a parameters file, a
  configuration file, a stylesheet, a font, an image) every edit leads to the same rebuild or
  reload it led to before.
- **`byte-exact-addresses`**: Across a corpus containing multi-byte and astral text, slicing the
  stored bytes by any edge's `from` range yields exactly the request as written, in 100% of edges.
- **`broken-includes-heal`**: Every broken reference in the test corpus heals when its file is
  created, without reopening the session.
- **`one-change-one-analysis`**: In a session of 200 sources, a change to one source costs exactly
  one handler call, and a rewrite with identical bytes costs none.
- **`same-behaviour-every-realm`**: The acceptance suite passes unchanged in Node and in a
  browser, against the in-memory host.

## Assumptions

- The embedder is a developer tool; "user" throughout means the embedder, and technical terms are
  the glossary's, not implementation choices.
- BelType's Markdown include handler lives in BelType, because the include syntax is BelType's
  (*General over particular*).
- Without regions, requests inside HTML `<style>` blocks, `style` attributes and raw HTML in
  Markdown are missing from the graph; `replaces-beltype-lists` counts them as explained
  differences.
- Scripts stay unread, as the vision says. A script is a leaf reached by a `script src` edge; the
  modules it imports are missing from the graph until observation arrives, and
  `replaces-beltype-lists` counts them as explained differences. BelType keeps its module lexer
  until then.
- Debouncing and batching of change events are the host's concern; the Node host batches as
  BelType's watchers do today.
- A handler that throws has a bug; its exception propagates rather than being recorded as state.
- Package resolution and line-and-column display helpers wait until a consumer needs them.
