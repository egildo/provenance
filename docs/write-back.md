# Write-back

*Design, 2026-10-08; vocabulary aligned with the glossary the same day. Drafted on paper before any code, because drafting is where the defects show
up cheaply. Nothing here is built. Terms are [the glossary's](glossary.md) unless defined below.*

## What this is for

A tool builds a live model from plain text files: data, and a cascade of configuration that says how
to read the data. The user changes something in the model. The change must land in exactly the right
bytes of exactly the right file, and nothing else in that file may move. Cascata and Provenance
together are meant to make that a solved problem for any such tool — a floor-plan editor writing
back to a YAML dataset, BelType writing back to Markdown and CSS.

Reading is built: one address space, sources at versions, edges, change absorption. This document is
the other half.

## Vocabulary

- **Source / output.** A source is stored reality: a file someone wrote. An output is a projection
  of sources: rendered HTML, an SVG floor plan, an IFC model. **Outputs are never edited.** An edit
  made on an output travels back through its **stamp** — the source address the output element
  carries — to a source.
- **Edit.** One change to one source, recorded with two addresses (below).
- **Staged edit, index, preview, commit, rebase.** The glossary's editing terms, used here as
  defined there: an edit is *staged* (held in the session's *index*, not yet written); the *preview*
  is the base plus the index, what the user sees; *commit* writes it to disk; *rebase* moves staged
  edits onto a source's new version. This design amends two of them — *rebase* finds an edit by its
  semantic address, and a value changed on both sides is overridden rather than *conflicted* — see
  the glossary. (Jujutsu's working-copy-as-commit is the model for the preview.)
- **Format plug-in.** The one component that understands a format: it reads a source into a
  lossless positioned tree, locates a semantic path in it, and writes a value or a node in the
  source's own style.

## The edit record

An edit carries **two addresses**:

| Half | Fields | Used for |
|---|---|---|
| **Byte address** | source, base version, start, end, new bytes | applying the edit exactly, now |
| **Semantic address** | document, path in the format's own terms, intent | finding the target again after the bytes moved |

The **intent** is one of: *set this value*, *insert this child* (parked), *delete this node*
(parked). A path is the format plug-in's language: a JSON Pointer for YAML and JSON, a selector and
property for CSS, a heading path for Markdown, an element id for HTML and SVG.

Prior art: the Language Server Protocol's `WorkspaceEdit` — a list of `TextEdit`s (range plus new
text) against document versions, applied together, non-overlapping, every range referring to the
original document. Two departures, both deliberate. Ranges are **bytes**, not UTF-16 positions, so
nothing converts. And an LSP edit has no semantic half, so it dies the moment its document changes;
this one is rebased instead.

## Who does what

- **The tool** says which value changed. When a model value is computed rather than copied (a wall
  corner at an axis intersection), only the tool knows which input an edit belongs to. Neither
  library can infer it.
- **The format plug-in** turns an intent at a path into bytes, in the source's style, and finds a
  path again in new bytes. For YAML and JSON that is Cascata's adapter; for CSS, PostCSS; for
  Markdown, Provenance's units.
- **Provenance** holds the index, builds previews, absorbs disk changes, rebases through the
  plug-in, and commits.
- **Cascata** additionally answers which layer an inherited configuration value came from
  (`why()`) — needed only once inherited values become editable (parked).

One plug-in per format, shared by both libraries by shape: a format must never have two parsers
that can disagree about where its bytes are.

## The lifecycle of an edit

1. **Stage.** The tool names a source, a path and an intent. The plug-in locates the path in the
   base and produces the byte address. A new edit at a path that already has a staged edit
   **replaces** it — edits are never stacked, because an edit expressed against another edit's
   result is forbidden (the LSP rule, already Provenance's).
2. **Preview.** The preview is the base with every staged edit spliced in, applied from the
   end of the file backwards so earlier ranges stay valid. Re-reading the preview is how a
   preview is validated: validation is re-analysis, never a verdict from the plug-in.
3. **Rebase.** The disk changes under a source with staged edits. Each edit is found again on the
   new version by its semantic address; the preview is rebuilt on the new base. Three
   outcomes, each reported, none silent:
   - the path is found and its value on disk is unchanged since the edit's base → the edit
     carries over;
   - the path is found but its value on disk changed → **the session's edit wins** (last saver
     wins, per value), and the session is told it is overriding a newer value, with the disk's bytes
     it will replace; the edit stays marked as overriding until it is staged again;
   - the path is gone → the edit is dropped, and the session is told.
   - the edit now overlaps one staged before it → the later-staged edit is dropped as conflicted,
     and the session is told (the text moved; it is not a writer bug).
4. **Commit.** Each source's preview is written if the disk still holds its base; if not, step 3
   runs first. Afterwards the written bytes are the new base and the index empties for that source.

## The laws

Write-back is working when these hold. They are the conformance cases, written before the code.

- **L1 — Nothing changed, nothing written.** Open, commit with no edits: the disk is byte-identical.
- **L2 — What you set is what you read.** Set a value, commit, re-read: the value at that path is the
  one set, *of the same kind* (see finding 1).
- **L3 — Only the value moves.** Every byte outside the edit's range is identical: comments,
  indentation, quoting elsewhere, line endings, the byte-order mark.
- **L4 — An edit survives what does not touch it.** A disk change elsewhere in the file, before the
  commit, does not lose the edit or move it to the wrong place.
- **L5 — Last saver wins, per value.** A disk change to the same value is overridden, and reported;
  a disk change to any other value is kept.

L1 and L2 are the lens laws (get-then-put changes nothing; put-then-get returns the edit). L3 is
"edits are splices" made testable. L4 and L5 are the rebase, and the owner's rule for conflicts.

## Cases on paper

Byte offsets are 0-based, ends exclusive, counted by hand.

**The file** `walls.yaml`, 51 bytes:

```yaml
walls:
  W1:
    height: 3.2
  W2:
    height: 3.2
```

1. **Set `/walls/W2/height` to 3.4.** Byte address: 47–50, `3.2` → `3.4`. Committed file: identical
   except bytes 47–49. (L2, L3)
2. **No edit, commit.** 51 identical bytes. (L1)
3. **A colleague adds a comment line above, then the session commits case 1's edit.** The disk now
   begins with `# from survey 2026-09` and a newline, 22 bytes; the base no longer matches.
   Rebase `/walls/W2/height`: 69–72. Committed: the colleague's comment kept, `3.4` at 69–71. (L4)
4. **A colleague sets W2's height to 3.6 on disk; the session's edit says 3.4.** Committed: 3.4, and
   the session was told it overrode 3.6. (L5)
5. **A colleague sets W1's height to 3.0; the session's edit is on W2.** Committed: W1 at 3.0, W2 at 3.4.
   (L5)
6. **A colleague deletes W2.** The edit has nowhere to land: dropped, the session told. Nothing
   written for it.
7. **The same file saved with CRLF line endings.** W1's height is at 27–30. Setting it to 3.4 writes
   3 bytes at 27–29; every `\r\n` stays. (L3)
8. **The same file starting with a byte-order mark.** W1's height is at 28–31, the mark counted, as
   Cascata 1.9 counts it. The mark is still there after saving. (L3)
9. **Set W1's height to 3** (an integer) where the file has `3.2` (a decimal). See finding 1:
   written as `3.0`, so the value read back is still a decimal. (L2)
10. **A string that now needs quotes.** `note: north side` (value at 39–49 in a file with that line
    added under W1). Set it to `north: side`. Written as `"north: side"`, because the plain form
    would parse as a mapping; quoting style is the plug-in's, inferred from the file. (L2, L3)

**A CSS source**, `plan.css`:

```css
.wall {
  stroke: #333;
  stroke-width: 2px;
}
```

11. **Set `.wall` → `stroke-width` to `3px`.** Byte address: 40–43. PostCSS's raws keep everything
    else. (L2, L3)

## What drafting found

Each of these was invisible in the conversation that agreed the design, and surfaced only when a
case was written down.

1. **"What you set" must include the kind.** Cascata distinguishes integers from decimals, and a
   demand can require either. A plug-in that writes `3` over `3.2` changes the value's kind, and the
   next validation may refuse it. The plug-in keeps the replaced scalar's kind unless the intent
   says otherwise.
2. **Last-saver-wins needs a notice.** Without one, case 4 loses the colleague's 3.6 silently.
   Cascata's own stance — a normalization is reported, never silent — applies here.
3. **Edits are keyed by path.** Editing the same value twice must replace the first edit, not stack
   on it. Otherwise the second edit is "an edit against another edit's result".
4. **The first version can only edit values that are written in an editable source.** A wall height
   that comes from a schema default exists in the merged view and in no data file: it has no byte
   address. Until the cascade question is decided (parked), such an edit is refused with a message
   naming the layer the value comes from.
5. **The plug-in, not the tool, decides quoting and number spelling.** Case 10 needs the YAML rules;
   case 9 needs the kind rule; a computed coordinate like `12.300000000000001` needs a precision
   rule (parked). The tool hands over a value; the bytes are the plug-in's business.

## Forbids

| Rule | Forbids |
|---|---|
| Outputs are never edited | Writing to a rendered or generated file |
| Edits are splices | Regenerating a source from a tree; a printer touching bytes outside the edit |
| Nothing touches disk before commit | Any write outside commit |
| Edits keyed by path | Two staged edits at one path; an edit against another edit's result |
| One plug-in per format | Two parsers reporting positions in the same format |
| Nothing silent | An override, a drop, or a refusal without a notice |

## Parked, with what brings each back

- **Where an edit to an inherited value lands** — into the layer that won (as DevTools edits the
  winning CSS rule) or a new override nearer the user. Back when a consumer needs to edit a default.
- **Inserting and deleting entities** — needs format-preserving trees and style inference (copy the
  nearest sibling's formatting: `toml_edit`'s decor, PostCSS's raws, Roslyn's trivia). Back with the
  first consumer that adds a wall.
- **Saving several files at once** — atomic per file (write a temporary file, rename), with a story
  for stopping halfway across files. Back when one edit spans two files.
- **Inverses of computed values** — the tool's, but a helper may emerge once two tools have written
  one.
- **A precision rule for numbers** — likely declared by the schema. Back with the first geometry
  consumer.
- **A sandbox for writes** — write only inside granted roots; never to a remote or pinned
  document. Back before the first release that writes, not after.

## The first build

A walking skeleton: YAML values only (set, no insert or delete), one file, a session with staged
edits, rebase by semantic address, per-value last-saver-wins with its notice, commit. On a small geometry
fixture. Proven when cases 1–10 pass as written above.
