# Research: Source graph kernel

Every claim below was checked on 2026-09-23 against the page named beside it; package figures are
from `npm view` the same day. Cascata's host is quoted from `cascata/src/resolve/host.ts` and
`cascata/src/paths.ts` (v1.8.1); BelType's bookkeeping from the survey recorded in
[the spec](spec.md).

## Runtime and toolchain

**Decision:** Node `>=22.18`, TypeScript 5.9 as the only build tool, `node --test` running `.ts`
files directly. `tsconfig`: `strict`, `erasableSyntaxOnly`, `verbatimModuleSyntax`,
`module: nodenext`, `rewriteRelativeImportExtensions`, `declaration`.

**Rationale:** Node enables type stripping by default from v22.18.0 and v23.6.0, with no
experimental warning from v22.18.0 and v24.3.0
([Node: TypeScript](https://nodejs.org/docs/latest-v22.x/api/typescript.html)). Stripping needs
`.ts` extensions on relative imports, which `rewriteRelativeImportExtensions` (TS 5.7) turns into
`.js` on emit; `erasableSyntaxOnly` (TS 5.8) rejects what stripping cannot erase
([TS 5.7](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-7.html),
[TS 5.8](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-8.html)).
`node --test` picks up `**/*.test.ts` by default ([Node: test runner](https://nodejs.org/api/test.html)).

**Alternatives:** a bundler or `tsx` for tests; rejected by the constitution's *Technology
constraints* (`tsc` and nothing else until a plan justifies more).

## Hashing

**Decision:** `crypto.subtle.digest("SHA-256", bytes)`, the Web Crypto global.

**Rationale:** it is a global in every target realm: Node without a flag since v19.0.0
([Node: globals](https://nodejs.org/api/globals.html)), browsers and workers in secure contexts,
and `http://localhost` is a secure context
([MDN: digest](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest),
[MDN: secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)).
It is async only, which costs nothing: every host call is async already. Hashing is computation,
not I/O, so it does not go through the host.

**Ceiling:** a page served over plain HTTP from a non-local address has no `crypto.subtle`.
Upgrade path, if an embedder ever needs it: a small pure SHA-256 in the core.

**Alternatives:** a hand-written SHA-256 (sync, ~60 lines, needs its own test vectors); the host
supplying hashes (rejected: a hash is a fact about bytes Provenance already holds, not about the
world).

## Text and offsets

**Decision:** decode with `new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })`; a decode
error makes the source `undecodable`. Convert every string index in findings to a byte offset in
one pass over the text, with the indices sorted.

**Rationale:** `fatal` turns invalid UTF-8 into an error instead of U+FFFD, which is what
`undecodable-text-is-a-state` needs. `ignoreBOM: true` keeps a byte-order mark in the text as
U+FEFF, so string indices and byte offsets stay aligned from the first byte. Every parser
considered (PostCSS, css-tree, parse5, htmlparser2) reports JavaScript string indices, so the
conversion is needed whatever the parser, and it happens once, in `offsets.ts`.

## CSS handler

**Decision (chosen by Egildo, 2026-09-23):** PostCSS. `postcss-safe-parser` builds the tree, and
`postcss-value-parser` finds `url()`s and strings inside declaration values and `@import`
parameters. The three packages are the CSS handler's only dependencies (postcss 8.5.28 with
`nanoid`, `picocolors`, `source-map-js`; safe parser 7.1.0; value parser 4.2.0).

It declares: every `url()` as a `candidate`; every string directly inside `image-set()` or
`-webkit-image-set()` as a `candidate`; an `@import`'s URL as `requires` when nothing but a
`layer` follows it, otherwise `candidate`. `@font-face` `src` needs no rule of its own: its
sources are `url()`s.

**Offsets.** PostCSS gives node offsets but no positions inside a value; the value parser's
`sourceIndex` and `sourceEndIndex` are relative to the string it was given
([PostCSS changelog](https://github.com/postcss/postcss/blob/main/CHANGELOG.md),
[value parser types](https://raw.githubusercontent.com/TrySound/postcss-value-parser/master/lib/index.d.ts)).
So the handler parses the value *as written*, `raws.value.raw` when PostCSS cleaned comments out
of it, and places it at `source.start.offset + prop.length + raws.between.length`; for `@import`,
`raws.params.raw` at `source.start.offset + 1 + name.length + raws.afterName.length`. A quoted
URL's node includes its quotes, which the handler trims. Probed on 2026-09-23 against the
versions above, with comments inside values and parameters, a custom property, spaces inside
`url( … )` and a non-ASCII prefix: every slice came out exactly as written.

**Malformed CSS.** `postcss.parse` throws `CssSyntaxError` on an unclosed bracket; the same
probe with `postcss-safe-parser` recovered and still found the URL inside the unclosed
`url(broken.png`. A broken stylesheet is a state of the world, not a handler bug, so the safe
parser is required, not optional.

**Ceiling.** All three packages are CommonJS (`postcss` adds an ESM wrapper over its CommonJS
build, and a `browser` field that stubs out `fs`, `path` and `url`). In a browser, the CSS handler
loads through a bundler, not through a bare import map. The core, the memory host and the HTML
handler (`parse5` 8 is ESM) load natively. Upgrade path, if a bundler-free browser embedder
appears: expose the scanner alternative below as a second CSS handler.

**Rationale:** the CSS tools build on a PostCSS root ([the glossary](../../docs/glossary.md),
*Artifact*). Parsing with PostCSS now means that tree can later be exposed as an artifact
instead of parsed a second time. The kernel itself exposes no artifacts yet.

**Alternatives:** a hand-written scanner over the
[CSS Syntax Level 3 tokenizer](https://www.w3.org/TR/css-syntax-3/#tokenization) with no
dependency (the first draft of this plan; rejected because the CSS tools would parse again);
css-tree, whose `Url` node spans the whole `url(…)` and brings 1.36 MB of dependencies
([css-tree AST](https://github.com/csstree/csstree/blob/master/docs/ast.md)).

## HTML handler

**Decision:** `parse5` 8 (`parse` with `sourceCodeLocationInfo: true`), walking the tree. Each
attribute's span covers `name="value"`, so the handler finds the value's start by skipping the
name, whitespace, `=`, whitespace and an opening quote. `srcset` is split by the WHATWG
[srcset parsing algorithm](https://html.spec.whatwg.org/multipage/images.html#parse-a-srcset-attribute),
hand-written, one edge per candidate URL.

**Rationale:** parse5 implements the WHATWG tree builder, so `<script>`, `<style>`, `<textarea>`,
templates and SVG foreign content switch tokenizer modes correctly, which a tokenizer alone
cannot do. It never throws on malformed HTML. Its only dependency is `entities`
(parse5 337 KB, entities 330 KB). Offsets are string indices; attribute values arrive
entity-decoded, which is what resolution needs, while the span keeps the text as written.

**Alternatives:** htmlparser2's `Tokenizer` gives value offsets directly but does not switch
modes by tree state, and its package brings `domhandler`, `domutils` and `dom-serializer`;
a hand-written HTML tokenizer (rejected: the tree builder's mode switches are the hard part).

## Resolution

**Decision:** three shipped resolvers, chosen by scheme. **Relative**: a request with no scheme
and not starting with `/`; strip `?query` and `#fragment`, percent-decode, and resolve against the
directory of the source's location (or the handler's base) with the host's `paths.resolve`; the
one location computed is the probe, and `host.canonicalize` answering `undefined` means nothing is
there. **External**: `http:`, `https:` and `//host/…` (read as `https:`) become external leaves, never
read; so does a relative request when the handler's base is a web URL (`<base href="https://…">`
or `//host/…`). A base that is a root-absolute path (`<base href="/">`, `<base href="/docs/">`) is a
URL path, not a directory: a relative request is joined to it the way a browser joins it, and
resolves as the root-absolute request that results (`style.css` under `/docs/` as `/docs/style.css`).
**None**: `data:`, an empty request, and a request that is only a fragment (`url(#glow)`, `href="#icon"`), make no
edge. Any other request, including a root-absolute `/…`, is unresolved
with no probes unless an embedder-supplied resolver claims it.

**Rationale:** Cascata's host already defines `canonicalize` as `undefined` when "the location
does not exist, a permission error, or any other reason". Using it as the existence test keeps
the host contract unchanged. What `/…` means is the embedder's: BelType resolves an include's `/`
against its root directory and a URL's `/` against its URL root, which is exactly the kind of
meaning *General over particular* keeps out of the core.

## Host contract and Cascata

**Decision:** Provenance's host is Cascata's `read` and `canonicalize`, a required `paths`
(Cascata's `PathFacility` shape), and one addition, `watch`. The session exposes a view of its
host to other readers that also answers Cascata's `cacheRead` (always `undefined`) and
`cacheWrite` (throws "no cache configured"), which Cascata's own contract allows for a host with
no cache; a successful `read` through that view adds a root. *Amended 2026-09-24: that view is
now each read pass's `host` ([read-passes](../read-passes/spec.md)), with the same cache answers.*

**Rationale:** `host-fits-cascata` with nothing Cascata does not already accept. Cascata requires
`cacheRead` and `cacheWrite` by type, so the view must carry them; answering them the way
Cascata's documentation permits defers a real cache until a consumer needs one, as the spec's
phase note says.

## Watching (Node host)

**Decision:** `fs.watch` on the parent directory of each watched location, non-recursive,
events debounced for 300 ms and delivered as one batch of locations. A batch says only that
something at these locations may have changed; the session re-reads and compares versions.

**Rationale:** watching directories rather than files survives a write-then-rename save, because
`fs.watch` on a file follows its inode and misses the replacement
([Node: fs.watch caveats](https://nodejs.org/api/fs.html#caveats)). Re-reading and hashing makes
the rename-save one change by construction: the temporary file is not watched, and the target's
new bytes are one new version. `filename` can be `null` on some platforms; the host then reports
every watched location in that directory. 300 ms matches BelType's two watchers today.

**Ceiling:** `fs.watch` is unreliable on network and container-mounted filesystems. Upgrade path:
chokidar behind the same `watch` contract.

## Browser verification

**Decision:** the test suite runs in Node only. Realm neutrality is enforced by the import
boundary test, and checked in a browser by the manual step in [quickstart.md](quickstart.md).

**Rationale:** running `node:test` suites in a browser needs a runner the constitution does not
yet justify. `same-behaviour-every-realm` stays a manual check until one is added.
