import { test } from "node:test";
import assert from "node:assert/strict";
import { html } from "../src/html.ts";

function found(text: string): [string, string, string][] {
  return html.analyze(text).requests.map(r => [r.request, r.kind, text.slice(r.start, r.end)]);
}

test("claims HTML only", () => {
  assert.equal(html.claims("/a.html"), true);
  assert.equal(html.claims("/a.htm"), true);
  assert.equal(html.claims("/a.css"), false);
});

test("stylesheets require unless conditioned or alternate", () => {
  assert.deepEqual(
    found(
      '<link rel="stylesheet" href="a.css"><link rel="stylesheet" href="p.css" media="print">' +
        '<link rel="alternate stylesheet" href="alt.css"><link rel="icon" href="i.png">' +
        '<link rel="preload" href="f.woff2"><link rel="canonical" href="c.html">',
    ),
    [
      ["a.css", "requires", "a.css"],
      ["p.css", "candidate", "p.css"],
      ["alt.css", "candidate", "alt.css"],
      ["i.png", "candidate", "i.png"],
      ["f.woff2", "candidate", "f.woff2"],
    ],
  );
});

test("images and frames require unless lazy", () => {
  assert.deepEqual(found('<img src="a.png"><img src=b.png loading="lazy"><iframe src=\'c.html\'></iframe>'), [
    ["a.png", "requires", "a.png"],
    ["b.png", "candidate", "b.png"],
    ["c.html", "requires", "c.html"],
  ]);
});

test("media are candidates; objects, scripts and SVG use require (a fragment-only use is dropped by the resolver)", () => {
  assert.deepEqual(
    found(
      '<video src="v.mp4" poster="p.jpg"><source src="s.webm"></video><audio src="a.ogg"></audio>' +
        '<object data="o.svg"></object><script src="s.js"></script>' +
        '<svg><use href="sprite.svg#i"></use><use xlink:href="old.svg#j"></use><use href="#local"></use></svg>',
    ),
    [
      ["v.mp4", "candidate", "v.mp4"],
      ["p.jpg", "candidate", "p.jpg"],
      ["s.webm", "candidate", "s.webm"],
      ["a.ogg", "candidate", "a.ogg"],
      ["o.svg", "requires", "o.svg"],
      ["s.js", "requires", "s.js"],
      ["sprite.svg#i", "requires", "sprite.svg#i"],
      ["old.svg#j", "requires", "old.svg#j"],
      ["#local", "requires", "#local"],
    ],
  );
});

test("srcset candidates, split as the HTML standard says", () => {
  assert.deepEqual(found('<img srcset="a.png 1x, b,c.png 2x,d.png"><picture><source srcset=" e.png 100w "></picture>'), [
    ["a.png", "candidate", "a.png"],
    ["b,c.png", "candidate", "b,c.png"],
    ["d.png", "candidate", "d.png"],
    ["e.png", "candidate", "e.png"],
  ]);
});

test("entities are decoded in the request and kept in the range", () => {
  assert.deepEqual(found('<link rel=stylesheet href="a&amp;b.css">'), [["a&b.css", "requires", "a&amp;b.css"]]);
});

test("the base, and what makes no request", () => {
  const findings = html.analyze('<base href="sub/"><a href="x.html">x</a><p style="background: url(n.png)">');
  assert.equal(findings.base, "sub/");
  assert.deepEqual(findings.requests, []);
  assert.deepEqual(found("<style>a { b: url(n.png) }</style><script>fetch('n.js')</script>"), []);
});

test("offsets hold after non-ASCII text, template content and malformed markup", () => {
  assert.deepEqual(found('<p>café ✓ 𝄞<template><img src="t.png"></template><div <img src="u.png">'), [
    ["t.png", "requires", "t.png"],
  ]);
  // A tag cut off by the end of the file is dropped, as the HTML standard drops it.
  assert.deepEqual(found('<p>𝄞</p><img src="v.png" <p'), []);
  assert.deepEqual(found('<p>𝄞</p><img src="v.png" <p>'), [["v.png", "requires", "v.png"]]);
});
