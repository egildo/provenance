# Design principles

**Status: draft, 2026-09-23.** These say how Provenance decides things. [The vision](vision.md) is normative on what Provenance is and what it is for; these are normative on how it is built. When the two collide, the vision wins on scope and these win on method.

Each principle states what it forbids. A principle that forbids nothing predicts nothing. Seven come from the [design synthesis](design-synthesis.md); two are Cascata's, carried over because Provenance has the same problems.

## One address space

Every fact Provenance holds is stated against an **address**: a source, a version, and a byte range into that version's stored bytes. Edges, stamps, observations and edits all speak it, so any two facts can be joined.

**Forbids:**
- a fact with no address;
- a second coordinate system past the handler boundary. String indices, UTF-16 offsets and code-point counts are converted to bytes where a handler hands them over, and nowhere else;
- stored lines and columns. They are derived for display, never kept as facts.

**Why:** BelType's file list and its URL list cannot be joined because they share no coordinates. Cascata's YAML parser reported UTF-16 indices that matched byte offsets on every ASCII test and on nothing else. (LSP's versioned documents, unist positions.)

## Handlers declare; Provenance decides

A **handler** is a pure function from a source's text to its findings: what it asks for, and which regions belong to another language. Resolving, caching, watching and writing belong to Provenance alone.

**Forbids:**
- a handler that reads, resolves, caches, watches or writes;
- a handler that returns anything but findings and optional artifacts, such as a parse tree.

**Why:** a handler that resolves its own requests hides the probes that invalidation needs. (PostCSS dependency messages, Parcel transformers.)

## Derived facts are pure functions of versions

Every analysis is cached by handler and content hash, so a new version invalidates it by construction. The probes a resolution made belong to the cached result, and a cache hit re-registers them.

**Forbids:**
- any "invalidate" call, anywhere;
- a cached fact keyed by path or by time;
- a cache hit that skips re-registering its probes.

**Why:** Parcel lost include invalidations by skipping exactly that last step. (Salsa, Build Systems à la Carte, Parcel PR #6072.)

## Declared and observed stay apart

A dependency found by parsing and a dependency seen at runtime are different facts with different origins. Provenance reports where they disagree.

**Forbids:**
- an observation that overwrites, upgrades or deletes a declared edge;
- a merged view that hides which origin a fact came from;
- smoothing a disagreement away. A fetch nothing declared is always reported.

**Why:** the fetch nothing declared is how a handler proves it is complete. Merging the two would erase the one signal that finds a handler's gaps.

## Source is the stored reality; renders are projections

Everything Provenance needs lives in its own structures or in rendered output. Stamps are `data-*` attributes on renders.

**Forbids:**
- writing any marker, identifier or annotation into a source file for Provenance's own use;
- treating a render as the source of truth for anything.

**Why:** an author's file belongs to the author. A tool that plants bookkeeping in it produces diffs nobody asked for.

## Nothing touches disk before commit

Edits are staged against a base version, previewed in memory, and written together. The bytes written are the bytes the preview showed.

**Forbids:**
- any write outside commit;
- a staged edit expressed against another staged edit's result. All edits in a source refer to its base version;
- overlapping edits in one source;
- a commit over a file whose bytes on disk no longer hash to its base version.

**Why:** a preview is only trustworthy if committing it cannot produce anything else. (LSP `WorkspaceEdit`, git's index.)

## Edits are splices

Provenance edits bytes, never trees. A language-aware consumer computes a splice from its parse tree's addresses and hands Provenance a plain text edit.

**Forbids:**
- a printer, a serializer, or any regeneration of a source from a tree;
- a committed change outside the staged ranges.

**Why:** untouched bytes stay untouched by construction, so formatting and comments survive without anyone having to preserve them.

## Languages are plugins; nesting is delegation

The core knows no language. A handler hands an embedded region, such as a `<style>` block in HTML, to the handler for that region's language, with a map back to the enclosing source's positions.

**Forbids:**
- language knowledge in the core;
- a handler parsing another language's region itself;
- an embedded finding whose address cannot be mapped back to a real source. Where the enclosing source escapes text, the region is marked **opaque**, and positions inside it map to the whole region.

**Why:** a font named in a `url()` inside a `<style>` inside raw HTML inside Markdown must still point at the right bytes of the right Markdown file. (Volar's mappings.)

## Supply, not meaning

Provenance performs no I/O. Bytes, canonical identity, path facts, watch events and writes are all asked of a **host**, which the embedder supplies. The host answers *what is there*; Provenance decides *what it means* and *what is allowed*.

**Forbids:**
- a `node:` import, or any platform facility, outside the shipped Node host's entry point. A test enforces this, not a convention;
- a host that returns a verdict instead of a fact, such as "this edit is allowed" or "this path is inside the project";
- an I/O call that bypasses the host, including for caching.

**Why:** Cascata imported `node:path`, `node:os` and `node:crypto` inside the library and failed at module evaluation in the browser, before a line of its own code ran. Taken from Cascata's host boundary, which is also what lets Cascata become a customer of Provenance without importing it.

## Broken is a state, not an exception

A reference that resolves nowhere is an **unresolved edge**, and a cycle is a recorded edge. Both are facts about the world, reported like any other fact. Programmer errors throw; nothing about the state of the world does.

**Forbids:**
- throwing for a missing file, a refused read, an unresolvable reference or a cycle;
- following a cycle;
- dropping an unresolved edge from the graph.

**Why:** a broken include has to stay visible, and has to heal by itself when the file appears. Its probes can only fire if the unresolved edge is still there to own them. (Cascata's "a refusal is data, not an exception".)
