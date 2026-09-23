# Implementation Plan: Source graph kernel

**Branch**: `source-graph-kernel` | **Date**: 2026-09-23 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/source-graph-kernel/spec.md`

## Summary

A zero-dependency TypeScript core that opens a session on an entry document plus roots, analyses
every reachable source to a fixpoint through pure handlers, resolves requests through resolvers
that record probes, keeps unresolved edges, and absorbs batches of host change events by
re-reading, re-hashing and re-analysing only what changed. It ships a CSS handler on PostCSS,
an HTML handler on `parse5`, an in-memory host and a Node host, each behind its own entry point.
Decisions and their sources are in [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript 5.9, `strict`, `erasableSyntaxOnly`; ES modules; Node `>=22.18`

**Primary Dependencies**: none in the core; `postcss`, `postcss-safe-parser` and
`postcss-value-parser` for the CSS handler only; `parse5` 8 for the HTML handler only

**Storage**: N/A. All state is in memory, for the life of a session

**Testing**: `node --test` over `test/*.test.ts` by type stripping; `tsc --noEmit` for types

**Target Platform**: any JavaScript realm with the Web Crypto global and `TextDecoder`; Node for
the Node host

**Project Type**: library

**Performance Goals**: a change to one source in a 200-source session costs one handler call;
a rewrite with identical bytes costs none (`one-change-one-analysis`)

**Constraints**: no platform import outside `src/node.ts`; no parser import outside its
handler; every offset a byte offset past `src/offsets.ts`

**Scale/Scope**: sessions of hundreds of sources, the size of a BelType document with its assets

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Checked before research and again after design; both passes agree.

**This constitution**

| Principle | Result |
| --- | --- |
| Lean | Pass. Parser dependencies only, each inside its handler: PostCSS and its safe and value parsers for CSS, `parse5` for HTML. PostCSS is chosen over a dependency-free scanner so the CSS tools can reuse its tree later (research, *CSS handler*). No extension point beyond the handler and resolver contracts the spec asks for. |
| General over particular | Pass. BelType's include syntax and `/` rules stay in BelType as a handler and a resolver it supplies. No consumer's name appears in `src/`. |
| Strict TypeScript | Pass. `strict`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, ES modules only. |
| Small public surface | Pass. The exports are exactly [contracts/public-api.md](contracts/public-api.md). No artifacts are exposed. |
| Every mechanism leaves a check | Pass, with one gap: the browser run is manual (research, *Browser verification*). Every other scenario is an automated test ([quickstart.md](quickstart.md)). |

**Design principles**

| Principle | Result |
| --- | --- |
| One address space | Pass. `src/offsets.ts` is the only converter; no line or column is stored. |
| Handlers declare; Provenance decides | Pass. `analyze(text)` gets text only and returns findings. |
| Derived facts are pure functions of versions | Pass. Findings are cached by handler and version; there is no invalidate; resolution is not cached, so probes are always registered. |
| Declared and observed stay apart | Pass. `origin` exists and is always `declared`. |
| Source is the stored reality; renders are projections | Pass. The kernel writes nothing. |
| Nothing touches disk before commit | Pass. There is no write path. |
| Edits are splices | Not applicable. No editing. |
| Languages are plugins; nesting is delegation | Pass. The core knows no language. The HTML handler does not scan `<style>` or `style` attributes for URLs, since that is the CSS handler's language. |
| Supply, not meaning | Pass. All I/O and path facts come from the host; hashing and decoding use realm globals, not the host. `canonicalize` answers identity; the kernel decides existence from it. A test enforces the import boundary. |
| Broken is a state, not an exception | Pass. Missing, refused, undecodable, unresolved and cyclic are source or edge states. |

## Project Structure

### Documentation (this feature)

```text
specs/source-graph-kernel/
├── spec.md
├── plan.md              # this file
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── public-api.md
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks, not yet
```

### Source Code (repository root)

```text
package.json             # exports: ".", "./css", "./html", "./memory", "./node"
tsconfig.json
src/
├── index.ts             # openSession and the public types
├── session.ts           # graph, fixpoint, change absorption, cycles, SessionHost view
├── offsets.ts           # string index → byte offset, one pass
├── resolvers.ts         # relative, external, none
├── css.ts               # PostCSS walk and handler
├── html.ts              # parse5 walk, srcset, handler
├── memory.ts            # in-memory host with POSIX paths
└── node.ts              # Node host; the only file that imports node:
test/
├── session.test.ts
├── offsets.test.ts
├── memory.test.ts
├── resolvers.test.ts
├── css.test.ts
├── html.test.ts
├── heal.test.ts
├── change.test.ts
├── node-host.test.ts
├── cascata.test.ts
├── boundary.test.ts
├── helpers.ts           # the test include handler and waiting helpers
└── browser.html         # manual browser check
```

**Structure Decision**: one package, one flat `src/`. The five entry points follow what an
embedder loads, not a layering scheme. `session.ts` holds the whole graph because every part of
it (sources, edges, probes, reachability) changes together in one change batch.

## Complexity Tracking

No violations to justify.
