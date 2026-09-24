# Quickstart: validating the source graph kernel

How to prove the kernel works, story by story. Shapes are in
[contracts/public-api.md](contracts/public-api.md); rules in [data-model.md](data-model.md).

## Prerequisites

- Node 22.18 or later (`node --version`).
- `npm install` at the repository root.

## Automated checks

```bash
npm test
```

`npm test` runs `tsc --noEmit` and then `node --test`. Every scenario below is a test in `test/`;
all run against the memory host, and the ones marked *(node)* also against the Node host on a
temporary directory, in `node-host.test.ts`.

| Spec scenario | Test | Expected |
| --- | --- | --- |
| Story 1, include chain | `session.test.ts` | three sources, two `requires` edges, each `from` slicing to its request |
| Story 1, font from CSS | `css.test.ts` | the font is a `leaf`; the handler never sees its bytes |
| Story 1, non-ASCII prefix | `offsets.test.ts` | with `café ✓ 𝄞` before a request, `from` counts `é`, `✓` and `𝄞` as 2, 3 and 4 bytes, not as 1, 1 and 2 string units |
| Story 1, cycle | `session.test.ts` | both edges recorded, one cycle of two sources reported |
| Story 1, roots | `session.test.ts` | an added stylesheet root and its font join; removing the root drops both |
| Story 2, heal *(node)* | `heal.test.ts`; `node-host.test.ts` | unresolved edge with one probe; after `write`, resolved, one handler call |
| Story 2, refused read | `session.test.ts` | source `refused` with the host's reason; nothing throws |
| Story 3, change *(node)* | `change.test.ts`; `node-host.test.ts` | one change report naming the source; one handler call |
| Story 3, same bytes | `change.test.ts` | no report, no handler call |
| Story 3, unreachable | `change.test.ts` | the dropped source is in `removed` and no longer watched |
| Story 3, shared cache | `change.test.ts` | two identical files, one handler call, both heal |
| Story 4, rename save *(node)* | `node-host.test.ts` | write a temp file, rename over the target: one change |
| Story 4, Cascata | `cascata.test.ts` | files read through a read pass's `host` become roots |
| Story 4, boundary | `boundary.test.ts` | no `node:` import outside `src/node.ts`; no `parse5` import outside `src/html.ts`; no `postcss` import outside `src/css.ts` |

`cascata.test.ts` drives a read pass's `host` exactly as Cascata calls it (`canonicalize`, then `read`),
using a type assertion against Cascata's `Host` shape copied into the test. It does not install
Cascata.

## Browser check (manual)

Until a browser test runner is justified (see [research.md](research.md#browser-verification)):

1. `npm run build` to write `dist/` (plain `tsc` only type-checks).
2. Serve the repository root on `http://localhost` with any static server.
3. Open `test/browser.html`, which maps `parse5` and `entities` from `node_modules` with an
   import map, imports `dist/index.js`, `dist/html.js` and `dist/memory.js`,
   and replays the story 1 and story 3 scenarios with HTML sources in place of CSS ones (the CSS
   handler needs a bundler in a browser; see [research.md](research.md#css-handler)), printing
   `PASS` or the first failure.

Expected: `PASS`, and no errors in the console.

## The proof in BelType

`replaces-beltype-lists` and `replaces-beltype-watchers` are measured in the BelType repository,
on a branch, after this feature lands. They are not tasks of this feature.

1. For each BelType example document, open a session with BelType's Markdown include handler,
   `css`, `html`, a resolver for BelType's `/` rules, and the configuration's stylesheets and
   plugins added as roots.
2. Compare `sources()` with `readSet` plus the local `closure.entries`. Every difference must be
   one of the spec's named exclusions: requests inside `<style>` and `style` attributes, or
   modules imported by scripts.
3. Replace both watchers with `session.onChange`, and replay the scripted edits named in the
   spec. Each must still lead to the same rebuild or reload.
