# Changelog

## 0.7.0 — 2026-10-29

**Atomic commit and the saveable index** ([atomic-commit](specs/atomic-commit/spec.md), [saveable-index](specs/saveable-index/spec.md), [design](docs/write-back.md)), for the BelType studio: a document made of includes, edited as one, its edits kept across reloads and committed together ([Codeberg issue](https://codeberg.org/egildo/provenance/issues/1)).

- **A commit lands every staged file, or none.** Every source is checked, rebased and its new text analysed before any is written. A refused source, a failed read, a dropped edit, or a handler that throws on the new text stops the commit with nothing on disk; an override does not. A write that fails puts back the files already written, newest first, after checking each still holds what the commit wrote (a colleague's save since is left alone). LSP's `WorkspaceEdit` calls this `undo`.
- **The report says which.** `CommitReport.outcome` is `committed` or `aborted`. A source's outcome gains `aborted` (another source stopped the commit; `reason` names it; its edits stay staged) and `unrestored` (written, and could not be put back). `conflicted` now means at least one edit was dropped, and lists the dropped ones.
- **`session.save()` and `session.restore(saved)`.** The index as plain data that survives the structured clone (IndexedDB, `postMessage`): per source its base version, base bytes and edits, no byte ranges. A restore stages each edit again against the saved base through the writer, then rebases onto the version the session holds, so a change made on disk meanwhile is reported as any rebase reports it. A source that already has staged edits is refused, never merged.

Breaking: `CommitReport.outcome` is new and required; `SourceCommit.outcome` gains `aborted` and `unrestored`, so an exhaustive `switch` stops compiling; a commit with one bad source now writes nothing where it wrote the others; a handler that throws on the new text now leaves every file unwritten; `Session` gains `save` and `restore`.

## 0.6.2 — 2026-10-26

- **Provenance moves to the public npm registry.** It was published to GitHub Packages, which asks for a token even to read. `@egildo/provenance` is now on npmjs.org, its repository is Codeberg, and a workflow publishes a release tag from the GitHub mirror, by npm trusted publishing. The code is unchanged.

## 0.6.1 — 2026-10-12

- **A dropped edit says why, in the writer's words.** Where a writer's refusal caused a rebase to conflict an edit (`gone`, `exists`, `unwritable`), the notice and the commit report carry `detail`, the writer's reason. Outcomes the session decides alone (`overlap`, `changed`, `shifted`) carry none.
- **A writer that contradicts itself throws.** If its `inside` says an edit lies within a staged edit and its `amend` then says it does not, staging rejects, naming both answers, and the index is unchanged. It used to fall through to ordinary staging.
- Recorded, unchanged: `changed` is strict, so a colleague's reformat drops a pending delete; a delete restaged as a set goes last.

## 0.6.0 — 2026-10-12

**Insert and delete** ([spec](specs/insert-delete/spec.md), [fixes](specs/insert-delete/fixes.md), [design](docs/write-back.md)), on Cascata 1.15's opened document and 1.16's verbs for a caller that rebases. A minor release because the editing API changes shape.

- **A writer is `claims` and `open`.** `open(bytes)` parses once and answers `locate`, `write` and, optionally, `add`, `remove`, `inside`, `amend` and `shifted`. Each source version is opened once, however many edits it serves. Cascata 1.16's writers fit by shape.
- **`stage(location, { op, path, value? })`** takes JSON Patch's operation object with Cascata's verb names: `set`, `add`, `remove`. It replaces `stage(location, path, value)`. A staged edit carries its `op`.
- **Containers.** `EditData` replaces `EditValue`: a value may be a list or a `Map`, nested.
- **Insert and delete,** in the file's own style (the writer's). Two inserts at one spot keep their staging order.
- **One principle for conflicts.** A set follows last-saver-wins. An insert or a delete never overwrites a colleague's work on the same entry: a rebased insert whose key was added on disk is conflicted `exists`, and a rebased delete whose entry was changed on disk, attached comments included, is conflicted `changed`.
- **An edit inside a staged insert amends it,** through the writer's `inside` and `amend`, so paths stay the format's language. An edit inside a staged delete is refused.
- **The shift guard.** An edit through a list that changed length since its base is conflicted `shifted`, so an index never silently names another item.
- **Waiting.** A version on disk that does not open (a file saved mid-typing) no longer drops the staged edits. They wait against their base, with the writer's words; a commit of that source is refused; the next version that opens is rebased onto.
- **Refusal codes.** A writer's refusal may carry a `code`; the session reads `edit-target-exists`, `edit-target-absent` and `edit-parent-scalar` (Cascata 1.16.1's).

Breaking: `stage`'s signature, the `Writer` shape, `EditValue` (now `EditData`), and an unparseable version no longer conflicts edits as `unwritable`.

## 0.5.0 — 2026-10-08

**Write-back's first slice: the editing stage** ([design](docs/write-back.md), [spec](specs/editing/spec.md), [#4](https://github.com/egildo/provenance/issues/4)), and its first end-to-end proof with Cascata ([spec](specs/joining/spec.md)).

- **Writers.** A format plug-in's editing half (`claims`, `locate`, `write`), given to `openSession` as `writers`. Cascata 1.11's `yamlWriter()` and `jsonWriter()` fit it by shape.
- **Staging, the index, previews.** `session.stage(location, path, value)` stages a set edit against the source's base; a second edit at one path replaces the first. `index()`, `unstage()`, and `preview(id)` (the base with every staged edit spliced in, analysed and held while it stands).
- **Rebase by path.** When a staged source changes on disk, each edit is found again by its path and written again by its writer: moved, respelled, overriding a value changed on disk (kept and reported), or conflicted when the path is gone. Every outcome reaches change listeners through `Change.edits`.
- **Commit.** One file at a time, each atomically (the Node host writes a temporary file and renames it). The last to commit wins, per value, and says so. A report per edit (`written`, `overrode`, `conflicted`) and per source (`written`, `refused`, `failed`, `conflicted`). A throw after a file is written leaves that file committed.
- **A write sandbox.** `writable` roots, judged on canonical locations segment by segment; absent means nothing is writable.
- **`Host.write`**, optional: a host without it can stage and preview, and commit refuses.
- **Proven end to end** on a geometry fixture: the hand-counted cases of the design, through Cascata's writer, a cascade through Cascata's `editTarget` (a schema default refused as inherited), and a run on a real disk.
- Cascata is a **development** dependency only; nothing in the library imports it. Building Provenance therefore needs a GitHub Packages token (README, "Install").
- **One value type across both libraries**: `EditValue` (string, number, big integer, boolean or null), the same union as Cascata's, so an object value is a compile error.
- **Overlap after a rebase** is rechecked: the later-staged of two overlapping edits is conflicted. A restaged edit counts as staged last.
- **Every conflict carries its reason** (`ConflictReason`): `gone`, `overlap` or `unwritable`.
- Tested on a real disk: `editTarget` through the symlinked macOS temporary directory, a read racing a commit (never a torn file), and a writable root given in the wrong letter case.
- Tests close their sessions and remove their directories however they end, so a failing real-disk test fails in seconds instead of hanging the runner.

Known edges, not fixed: a non-atomic rename (Windows, network file systems), a crash mid-commit, and Windows drive letters in the write sandbox are untested.

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
