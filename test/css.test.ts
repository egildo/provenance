import { test } from "node:test";
import assert from "node:assert/strict";
import { css } from "../src/css.ts";
import { openSession } from "../src/index.ts";
import type { Findings, Handler } from "../src/index.ts";
import { createMemoryHost } from "../src/memory.ts";

/** Each request with the text its range covers, which must equal the request when nothing is escaped. */
function found(text: string): [string, string, string][] {
  return css.analyze(text).requests.map(r => [r.request, r.kind, text.slice(r.start, r.end)]);
}

test("claims stylesheets only", () => {
  assert.equal(css.claims("/a/b.css"), true);
  assert.equal(css.claims("/a/b.html"), false);
});

test("every url() is a candidate, its range the URL as written", () => {
  assert.deepEqual(found('a { b: url(a.png); c: url( "b c.png" ) , url(\'d.png\') }'), [
    ["a.png", "candidate", "a.png"],
    ["b c.png", "candidate", "b c.png"],
    ["d.png", "candidate", "d.png"],
  ]);
});

test("custom properties and @font-face sources", () => {
  assert.deepEqual(found(":root { --v: url(k.png) } @font-face { src: url(f.woff2) format('woff2'), local(F) }"), [
    ["k.png", "candidate", "k.png"],
    ["f.woff2", "candidate", "f.woff2"],
  ]);
});

test("strings directly inside image-set() are candidates", () => {
  assert.deepEqual(found('a { b: image-set("p.png" 1x, url(q.png) 2x); c: -webkit-image-set("r.png" 1x) }'), [
    ["p.png", "candidate", "p.png"],
    ["q.png", "candidate", "q.png"],
    ["r.png", "candidate", "r.png"],
  ]);
});

test("@import requires unless a condition follows", () => {
  assert.deepEqual(found('@import "x.css" layer(l); @import url(y.css) screen; @import "z.css" supports(display: grid); @import url("w.css");'), [
    ["x.css", "requires", "x.css"],
    ["y.css", "candidate", "y.css"],
    ["z.css", "candidate", "z.css"],
    ["w.css", "requires", "w.css"],
  ]);
});

test("comments inside values and parameters do not shift ranges", () => {
  assert.deepEqual(found("/* café ✓ */ @import /* c */ 'b.css'; a { b : url(c.png) /* note */ ; }"), [
    ["b.css", "requires", "b.css"],
    ["c.png", "candidate", "c.png"],
  ]);
});

test("CSS escapes are undone in the request, kept in the range", () => {
  assert.deepEqual(found('a { b: url("x\\"y.png") }'), [['x"y.png', "candidate", 'x\\"y.png']]);
});

test("broken CSS still yields its requests and never throws", () => {
  assert.deepEqual(found("a { b: url(ok.png) } c { d: url(broken.png"), [
    ["ok.png", "candidate", "ok.png"],
    ["broken.png", "candidate", "broken.png"],
  ]);
});

test("a fragment-only url() is still reported; the resolver drops it", () => {
  assert.deepEqual(found("a { filter: url(#glow) }"), [["#glow", "candidate", "#glow"]]);
});

test("a font reached from CSS is a leaf whose bytes reach no handler", async () => {
  const seen: string[] = [];
  const spy: Handler = { claims: css.claims, analyze: (text): Findings => (seen.push(text), css.analyze(text)) };
  const host = createMemoryHost({ "/a.css": "@font-face { src: url(f.woff2) }", "/f.woff2": new Uint8Array([0, 1]) });
  const session = await openSession({ host, entry: "/a.css", handlers: [spy] });
  assert.deepEqual(session.sources().map(s => [s.location, s.state]), [
    ["/a.css", "analysed"],
    ["/f.woff2", "leaf"],
  ]);
  assert.deepEqual(seen, ["@font-face { src: url(f.woff2) }"]);
});
