# Data model: Source graph kernel

Definitions are [the glossary's](../../docs/glossary.md); this file adds fields, states and rules.
TypeScript shapes are in [contracts/public-api.md](contracts/public-api.md).

## Source

| Field | Meaning |
| --- | --- |
| `id` | Minted by the session (`s1`, `s2`, …), stable for the session's life. |
| `location` | The host's canonical location; for an external leaf, the URL as resolved. |
| `state` | See below. |
| `version` | SHA-256 of the stored bytes, lowercase hex. Absent for `external` and `refused`. |
| `handler` | The handler that claimed it, if any. |

States:

- `analysed`: claimed, decoded, analysed.
- `leaf`: no handler claims it; read and hashed, never decoded.
- `undecodable`: claimed, but not valid UTF-8; hashed, not analysed.
- `refused`: the host refused the read; carries the host's `reason`.
- `external`: an `http(s)` target; never read.

One source per canonical location. A source exists while it is a root or the target of an edge
from a reachable source; otherwise it leaves the session.

## Address

`{ source, version, start?, end? }`. Offsets are bytes into that version's stored bytes, `start`
inclusive, `end` exclusive; both absent means the whole source.

## Edge

| Field | Meaning |
| --- | --- |
| `from` | Address of the span that asks, in the asking source's current version. |
| `request` | The request after its language's own unescaping (HTML entities, CSS escapes). Equals the bytes at `from` when nothing was escaped. |
| `target` | A source id, or absent when unresolved. |
| `kind` | `requires` or `candidate`. |
| `origin` | Always `declared` in this feature. |
| `probes` | Every location its resolution tried. |

An edge belongs to its asking source's version: a new version replaces all its edges. Two
requests for the same target are two edges.

## Findings

`{ requests: { start, end, request, kind }[], base? }`, with `start`/`end` as string indices into
the text the handler received. Converted to byte offsets on receipt (`offsets.ts`), never later.

## Session

- **Roots**: the entry location, locations the embedder adds, and locations read successfully
  through the session's host view by someone else.
- **Reachable**: roots plus every target of an edge from a reachable source.
- **Watched**: the location of every non-external source, plus every probe.
- **Cycles**: strongly connected components of the edge graph with more than one source, or a
  source with an edge to itself.

## Rules

1. **Fixpoint.** A worklist starts from the roots. Each source is read, hashed, analysed (or
   not, by state), its requests resolved; each new target joins the worklist. Analysis ends when
   the worklist is empty. A cycle's second visit finds the source already present and stops.
2. **Cache.** Findings are cached per handler object, keyed by version. The cache survives across
   sessions sharing a handler. Resolution is not cached, so every analysis, fresh or cached,
   registers its probes.
3. **Change.** For a batch of locations: every source at one of them is re-read; a new version
   is re-analysed and its edges replaced; a missing one leaves its location's edges to re-resolve.
   Every edge that probed one of them is re-resolved. Then reachability is recomputed, new
   sources analysed, unreachable ones dropped, the watched set updated, and one change reported.
4. **Report.** `{ added, removed, changed }`, lists of source ids; `changed` means a new version.
   A batch that changes nothing reports nothing.
