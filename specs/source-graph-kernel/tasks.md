---

description: "Task list for the source graph kernel"
---

# Tasks: Source graph kernel

**Input**: Design documents from `specs/source-graph-kernel/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/public-api.md](contracts/public-api.md),
[quickstart.md](quickstart.md)

**Tests**: included. The constitution's *Every mechanism leaves a check* requires them, and
[quickstart.md](quickstart.md) maps every spec scenario to a test file. Within each story, write
the tests first and see them fail.

**Organization**: tasks are grouped by user story. Requirement and success-criterion names
(`keep-unresolved-edges`, `one-change-one-analysis`, …) are the spec's.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the user story from [spec.md](spec.md) (US1 to US4)

## Rules for every task

- TypeScript `strict`, erasable syntax only: no `enum`, `namespace` or parameter properties; no
  `any`; relative imports end in `.ts`.
- No `node:` import outside `src/node.ts`; no `parse5` outside `src/html.ts`; no `postcss*`
  outside `src/css.ts`.
- Missing, refused, undecodable, unresolved and cyclic are states, never exceptions. Only
  invalid arguments and a throwing handler throw (`broken-is-reported-not-thrown`).
- Export exactly what [contracts/public-api.md](contracts/public-api.md) names, nothing more.

---

## Phase 1: Setup

**Purpose**: an empty package that builds and runs an empty test suite.

- [X] T001 Create `package.json` at the repository root: `"name": "@egildo/provenance"`, `"type": "module"`, `"engines": {"node": ">=22.18"}`, `"files": ["dist"]`, and `exports` for `.`, `./css`, `./html`, `./memory`, `./node`, each `{"types": "./dist/<name>.d.ts", "import": "./dist/<name>.js"}` (`.` maps to `index`). Scripts: `"build": "tsc -p tsconfig.build.json"`, `"test": "tsc && node --test"`. Dependencies: `parse5` `^8.0.1`, `postcss` `^8.5.28`, `postcss-safe-parser` `^7.1.0`, `postcss-value-parser` `^4.2.0`. Dev dependencies: `typescript` `^5.9`, `@types/node` matching Node 22. Run `npm install`.
- [X] T002 [P] Create `tsconfig.json` (type-checks `src` and `test`, `"noEmit": true`) with `strict`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `"module": "nodenext"`, `"target": "es2022"`, `"lib": ["es2022", "dom"]`, `rewriteRelativeImportExtensions` (not `allowImportingTsExtensions`, which would stop the build config from emitting; checked with TypeScript 5.9.3); and `tsconfig.build.json` extending it with `"include": ["src"]`, `"noEmit": false`, `"declaration": true`, `"outDir": "dist"`, `"rootDir": "src"`
- [X] T003 [P] Create `.gitignore` with `node_modules/` and `dist/`

**Checkpoint**: `npm test` passes with no tests; `npm run build` emits nothing yet.

---

## Phase 2: Foundational

**Purpose**: the types, the offset converter, the memory host and the resolvers, which every story
uses.

**⚠️ CRITICAL**: no story work begins until this phase is complete.

- [X] T004 Create `src/index.ts` declaring every public type in [contracts/public-api.md](contracts/public-api.md) exactly as written there (`Session`, `Source`, `Address`, `Edge`, `Change`, `Handler`, `Findings`, `Resolver`, `Host`, `HostReadResult`, `PathFacility`, `SessionHost`), and re-exporting `openSession` from `./session.ts`. Create `src/session.ts` with `openSession` throwing `Error("not implemented")`.
- [X] T005 [P] Write `test/offsets.test.ts`: for text `café ✓ 𝄞 x`, the index of `x` (10) converts to byte offset 15 (é, ✓ and 𝄞 are 2, 3 and 4 bytes, not 1, 1 and 2 string units); a text starting with U+FEFF counts it as 3 bytes; unsorted and repeated indices convert correctly; index 0 and `text.length` convert to 0 and the byte length
- [X] T006 [P] Implement `src/offsets.ts`: `byteOffsets(text: string, indices: readonly number[]): number[]`, one pass over `text` with the indices sorted, counting UTF-8 bytes per code point (1 below U+0080, 2 below U+0800, 3 below U+10000, 4 for a surrogate pair, which advances the index by 2). The only string-index-to-byte converter in `src/` (*One address space*).
- [X] T007 [P] Write `test/memory.test.ts`: `paths.resolve("/a/b", "../c")` is `/a/c`, `resolve("/a", "./b/./c")` is `/a/b/c`, `dirname("/a/b.md")` is `/a`, `isAbsolute`; `canonicalize` returns the normalized location for an existing file and `undefined` for a missing one; `read` returns `{ok: true, bytes}`, `{ok: false, reason: "not found"}` for a missing file, and the given reason after `refuse`; two `write` calls in one synchronous run reach a watcher as one batch at the next microtask, and only for locations in its watched set; `close()` stops delivery
- [X] T008 [P] Implement `src/memory.ts`: `createMemoryHost(files?)` returning a `Host` plus `write`, `remove` and `refuse` as specified in [contracts/public-api.md](contracts/public-api.md). POSIX `paths` (`separator: "/"`, `homeDirectory: undefined`, `dirname`, `isAbsolute`, `resolve` collapsing `.` and `..`), strings stored as UTF-8 bytes, events queued and delivered with `queueMicrotask`
- [X] T009 [P] Write `test/resolvers.test.ts` against the memory host: `./b.md?v=1#top` from `/d/a.md` probes `/d/b.md` and targets it when it exists; `%20` is decoded; a missing target gives `{probes: ["/d/b.md"]}` with no `target`; `https://x/y.css` and `//x/y.css` give `{external}`; `data:…`, `#glow` give `null`; `/abs.css` and `mailto:x` are claimed by no shipped resolver; a handler base replaces the source's directory
- [X] T010 [P] Implement `src/resolvers.ts` per [research.md](research.md#resolution): `relative`, `external` and `none` resolvers with the `Resolver` shape, and `resolve(request, base, host, embedderResolvers)` that tries embedder resolvers first, then the shipped ones, and returns an unresolved result with no probes when none claims the request. Existence is `host.canonicalize(location) !== undefined`; `target` is the canonical location.

**Checkpoint**: `npm test` passes offsets, memory and resolver tests.

---

## Phase 3: User Story 1 - Know every source a document depends on (Priority: P1) 🎯 MVP

**Goal**: `openSession` analyses the entry and its roots to a fixpoint and answers every query in
the contract.

**Independent Test**: [quickstart.md](quickstart.md) rows for story 1 pass against the memory host.

### Tests for User Story 1

- [X] T011 [P] [US1] Write `test/session.test.ts` with a test-only include handler defined in the file (claims `*.md`; `@include{src="…"}` on its own line; the `src` value as a `requires` request). Cases: `a.md → b.md → c.md` gives three `analysed` sources and two edges whose `from` range, sliced from the stored bytes, equals the request; a cycle `a.md ↔ b.md` gives both edges and `cycles()` of one two-source cycle, and opening returns; `./x/../b.md` and `b.md` are one source; a `.png` target is a `leaf`; invalid UTF-8 in a claimed file makes it `undecodable` with a version, not analysed; a missing entry is reported, not thrown; `addRoot` of a stylesheet brings it and its font in, `removeRoot` drops both; `data:` makes no edge and `https:` makes an `external` source that is never read; `edgesFrom`, `edgesInto` and `unresolved` answer as the data model says
- [X] T012 [P] [US1] Write `test/css.test.ts` for the `css` handler alone: `url(a.png)`, `url( "b c.png" )` (the range excludes the quotes and spaces) and a `url()` inside a custom property are `candidate`s; strings directly in `image-set()` and `-webkit-image-set()` are `candidate`s; `@import "x.css" layer(l);` is `requires`, `@import url(y.css) screen;` and `@import "z.css" supports(display: grid);` are `candidate`s; comments inside a value and inside `@import` parameters do not shift ranges; `a { b: url(broken.png` returns its request and does not throw; `url(#f)` still returns a request (the resolver drops it). Plus one session case: a font reached from CSS is a `leaf` and its bytes never reach any handler (spy on `analyze`)
- [X] T013 [P] [US1] Write `test/html.test.ts` for the `html` handler alone: one case per row of the HTML table in [contracts/public-api.md](contracts/public-api.md), including `loading="lazy"`, `media`, `rel="alternate stylesheet"`, `link rel="canonical"` (no request) and `a href` (no request); `srcset="a.png 1x, b,c.png 2x"` gives `a.png` and `b,c.png` with their own ranges, per the [WHATWG algorithm](https://html.spec.whatwg.org/multipage/images.html#parse-a-srcset-attribute); `href="a&amp;b.css"` gives request `a&b.css` and a range covering `a&amp;b.css`; `<base href="sub/">` becomes `base`; `<use href="#i">` gives no request; URLs inside `<style>` and `style="…"` give none; malformed HTML does not throw

### Implementation for User Story 1

- [X] T014 [US1] Implement the fixpoint in `src/session.ts` per [data-model.md](data-model.md) rules 1 and 2: roots start as `[entry]`; a worklist reads each location through the host, hashes with `crypto.subtle.digest("SHA-256", bytes)` as lowercase hex, picks the first handler in registration order whose `claims` is true, decodes with `new TextDecoder("utf-8", {fatal: true, ignoreBOM: true})` (a throw means `undecodable`), gets findings from a `WeakMap<Handler, Map<version, Findings>>` cache or `analyze`, converts ranges with `byteOffsets`, and resolves each request with `src/resolvers.ts` against the findings' `base` or the source's directory. Sources are keyed by canonical location with ids `s1`, `s2`, … Implement `sources`, `source`, `edgesFrom`, `edgesInto`, `unresolved`, `addRoot` and `removeRoot` (dropping sources no longer reachable). Every edge has `origin: "declared"`.
- [X] T015 [US1] Implement `cycles()` in `src/session.ts` as the strongly connected components of the resolved-edge graph with more than one source, or one source with an edge to itself (Tarjan)
- [X] T016 [P] [US1] Implement `src/css.ts` exporting `css: Handler` (claims `*.css`) per [research.md](research.md#css-handler): parse with `postcss-safe-parser`; for each declaration parse `decl.raws.value?.raw ?? decl.value` with `postcss-value-parser`, placed at `decl.source.start.offset + decl.prop.length + decl.raws.between.length`; for each `@import` parse `raws.params?.raw ?? params`, placed at `source.start.offset + 1 + name.length + raws.afterName.length`; trim the quotes of a `string` node; unescape CSS escapes in `request`
- [X] T017 [P] [US1] Implement `src/html.ts` exporting `html: Handler` (claims `*.html`, `*.htm`) per [research.md](research.md#html-handler) and the HTML table in [contracts/public-api.md](contracts/public-api.md): `parse5.parse(text, {sourceCodeLocationInfo: true})`, walk every element including `<template>` content and SVG; find each attribute value's start inside `sourceCodeLocation.attrs[name]` by skipping the name, whitespace, `=`, whitespace and an opening quote; `request` is parse5's decoded value; split `srcset` by the WHATWG algorithm; report `<base href>` as `base`

**Checkpoint**: story 1 rows of the quickstart pass. This is the MVP: a file list and a URL list
in one structure.

---

## Phase 4: User Story 2 - Broken references stay visible and heal (Priority: P1)

**Goal**: unresolved edges keep their probes, and a file appearing at a probe heals them.

**Independent Test**: [quickstart.md](quickstart.md) rows for story 2 pass against the memory host.

- [X] T018 [P] [US2] Write `test/heal.test.ts` against the memory host: `a.md` includes `missing.md`; opening does not throw; `unresolved()` holds the edge with `probes: ["/…/missing.md"]`; after `host.write("/…/missing.md", …)` and one microtask, the edge's `target` is set, `missing.md` is `analysed`, `onChange` reports it in `added`, and the handler ran exactly once more. Add to `test/session.test.ts`: a `refused` file is a source with the host's `reason` and nothing throws.
- [X] T019 [US2] In `src/session.ts`, keep a probe index (`Map<location, Set<Edge>>`), call `host.watch` once at open and `set()` the watched set (every non-external source location plus every probe) after each fixpoint; on a batch, re-resolve every edge whose probes include a reported location and analyse newly reachable targets (`probes-heal-edges`)

**Checkpoint**: stories 1 and 2 pass independently.

---

## Phase 5: User Story 3 - Stay current as files change (Priority: P2)

**Goal**: one change report per batch, and only changed sources re-analysed.

**Independent Test**: [quickstart.md](quickstart.md) rows for story 3 pass against the memory host.

- [X] T020 [P] [US3] Write `test/change.test.ts` against the memory host, counting handler calls with a spy: changing `b.md` reports `{changed: [b's id]}` once and costs one call; rewriting identical bytes reports nothing and costs none; editing `b.md` to drop its include of `c.md` reports `c.md` in `removed`, and a later `write` to `c.md` reports nothing (no longer watched); two files with identical bytes cost one call, and both their missing includes heal (`cache-hit-reregisters-probes`); a session of 200 generated sources costs one call for one change (`one-change-one-analysis`)
- [X] T021 [US3] Implement change absorption in `src/session.ts` per [data-model.md](data-model.md) rules 3 and 4: for each reported location, re-read its source; if the version changed, replace its edges and re-analyse; if it is gone, re-resolve the edges into it; re-resolve probed edges (T019); recompute reachability from the roots; analyse new sources; drop unreachable ones; update the watched set; emit one `Change {added, removed, changed}` to `onChange` listeners, or none if all three are empty. `close()` closes the watch.

**Checkpoint**: stories 1 to 3 pass.

---

## Phase 6: User Story 4 - Run in any JavaScript realm (Priority: P2)

**Goal**: the Node host, the Cascata-shaped session host, and the import boundary.

**Independent Test**: [quickstart.md](quickstart.md) rows for story 4 pass, and the *(node)* rows
of stories 2 and 3 pass against the Node host.

- [X] T022 [P] [US4] Write `test/boundary.test.ts`: read every file in `src/` and fail if any `node:` import appears outside `src/node.ts`, `parse5` outside `src/html.ts`, or `postcss`, `postcss-safe-parser` or `postcss-value-parser` outside `src/css.ts`; `src/index.ts`, `src/session.ts`, `src/offsets.ts`, `src/resolvers.ts` and `src/memory.ts` import only relative paths
- [X] T023 [P] [US4] Write `test/cascata.test.ts`: declare Cascata's `Host` interface in the test exactly as in `cascata/src/resolve/host.ts` v1.8.1 (`read`, `canonicalize`, `cacheRead`, `cacheWrite`, optional `locate` and `paths`), assign `session.host` to it (a type error fails `npm test`); call `canonicalize` then `read` on a `config.yaml` the entry never mentions and check it is now a source and a root; `cacheRead` resolves `undefined`; `cacheWrite` rejects with "no cache configured"
- [X] T024 [P] [US4] Write `test/node-host.test.ts` on a directory from `fs.mkdtemp`: repeat the heal case of T018 and the change and same-bytes cases of T020 with `createNodeHost({debounce: 50})`; a save by writing `b.md.tmp` then renaming it over `b.md` yields exactly one change naming `b.md`; `canonicalize` follows a symlink to the real path
- [X] T025 [US4] Implement `session.host` in `src/session.ts` as a `SessionHost`: `read` delegates and, on `ok`, canonicalizes the location and adds it as a root if not already one; `canonicalize` and `paths` delegate; `cacheRead` resolves `undefined`; `cacheWrite` rejects with `Error("no cache configured")`
- [X] T026 [P] [US4] Implement `src/node.ts` exporting `createNodeHost({debounce = 300} = {})` per [research.md](research.md#watching-node-host): `read` with `fs.promises.readFile`, a failure becoming `{ok: false, reason}` from the error's code and message; `canonicalize` with `fs.promises.realpath`, `undefined` on any failure; `paths` from `node:path` with `homeDirectory` from `os.homedir()`; `watch` keeping one non-recursive `fs.watch` per parent directory of the watched set, debouncing into one batch of watched locations (all watched locations in that directory when `filename` is `null`), and closing watchers no longer needed on `set()`
- [X] T027 [P] [US4] Create `test/browser.html` per [quickstart.md](quickstart.md#browser-check-manual): an import map for `parse5` and `entities` from `node_modules`; imports `dist/index.js`, `dist/html.js` and `dist/memory.js`; replays story 1 and story 3 with HTML sources; prints `PASS` or the first failure

**Checkpoint**: all automated quickstart rows pass.

---

## Phase 7: Polish and agreement

- [X] T028 [P] Update `README.md`: status "the kernel is built; observation and editing are not", a short usage example with `openSession`, `createNodeHost`, `css` and `html`, and a link to [contracts/public-api.md](contracts/public-api.md)
- [X] T029 [P] Create `CHANGELOG.md` with an `Unreleased` entry naming the kernel and its five entry points
- [X] T030 Run `npm test` and `npm run build`, then the manual browser check in [quickstart.md](quickstart.md#browser-check-manual)
- [X] T031 Agreement check (constitution, *Agreement before landing*): compare every export in `dist/*.d.ts` with [contracts/public-api.md](contracts/public-api.md), every state and rule in [data-model.md](data-model.md) with `src/session.ts`, and every term used in `src/` doc comments with [docs/glossary.md](../../docs/glossary.md); fix whichever side is wrong, in this branch

---

## Dependencies and execution order

- **Setup (T001 to T003)**, then **Foundational (T004 to T010)**, then the stories.
- **US1** needs the foundational phase. **US2** extends `src/session.ts` after T014. **US3**
  extends it after T019. **US4**: T025 needs T014; T024 needs T019 and T021; T022, T023, T026
  and T027 can start once US1 is done.
- `src/session.ts` is touched by T014, T015, T019, T021 and T025, in that order; those tasks
  never run in parallel with each other.
- Within a story, write its tests first and see them fail.

## Parallel opportunities

- Foundational: T005 and T006, T007 and T008, T009 and T010 are three independent pairs.
- US1: T011, T012 and T013 together; then T016 and T017 alongside T014 and T015.
- US4: T022, T023, T026 and T027 together.
- Polish: T028 and T029 together.

## Implementation strategy

1. **MVP**: Setup, Foundational, US1. Stop and validate: a session over the memory host already
   lists every source and edge, which is the file list and URL list in one structure.
2. **Heal** (US2), then **change** (US3): the session becomes a replacement for BelType's two
   watchers.
3. **Realms** (US4): the Node host and the Cascata-shaped host make the BelType proof possible.
4. **Polish**, then the agreement check, then land. The BelType proof itself runs in the BelType
   repository afterwards ([quickstart.md](quickstart.md#the-proof-in-beltype)).
