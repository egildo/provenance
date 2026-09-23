// The CSS handler: `url()`, `image-set()` strings and `@import`, found with PostCSS
// (specs/source-graph-kernel/research.md, CSS handler). Embedded regions are not its concern.

import safeParse from "postcss-safe-parser";
import valueParser from "postcss-value-parser";
import type { Node as ValueNode } from "postcss-value-parser";
import type { Findings, Handler } from "./index.ts";

type Request = Findings["requests"][number];

/** Undoes CSS escapes: `\` and one to six hex digits (and one following space), or `\` and a character. */
function unescape(text: string): string {
  return text.replace(/\\(?:([0-9a-f]{1,6})[ \t\n]?|([^\n]))/gi, (_, hex: string | undefined, char: string | undefined) =>
    hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd) : (char ?? ""),
  );
}

/** The request a `url()` argument or a string holds, with its range in the whole text. */
function literal(node: ValueNode, offset: number, kind: Request["kind"]): Request | undefined {
  if (node.type === "word") {
    return { start: offset + node.sourceIndex, end: offset + node.sourceEndIndex, request: unescape(node.value), kind };
  }
  if (node.type === "string") {
    const end = node.unclosed ? node.sourceEndIndex : node.sourceEndIndex - 1;
    return { start: offset + node.sourceIndex + 1, end: offset + end, request: unescape(node.value), kind };
  }
  return undefined;
}

const isNamed = (node: ValueNode, ...names: string[]) =>
  node.type === "function" && names.includes(node.value.toLowerCase());

/** Every `url()`, and every string directly inside `image-set()`, in a value placed at `offset`. */
function urls(value: string, offset: number, requests: Request[]): void {
  valueParser(value).walk(node => {
    if (node.type !== "function") return;
    if (isNamed(node, "url")) {
      const found = node.nodes[0] && literal(node.nodes[0], offset, "candidate");
      if (found) requests.push(found);
      return false;
    }
    if (isNamed(node, "image-set", "-webkit-image-set")) {
      for (const child of node.nodes) {
        const found = child.type === "string" && literal(child, offset, "candidate");
        if (found) requests.push(found);
      }
    }
    return undefined;
  });
}

/** `@import`'s URL: required unless a condition (media, `supports()`) follows; a `layer` is not one. */
function importRequest(params: string, offset: number): Request | undefined {
  const nodes = valueParser(params).nodes.filter(n => n.type !== "space" && n.type !== "comment");
  const [first, ...rest] = nodes;
  if (!first) return undefined;
  const conditioned = rest.some(n => !(n.type === "word" && n.value.toLowerCase() === "layer") && !isNamed(n, "layer"));
  const kind = conditioned ? "candidate" : "requires";
  if (first.type === "string") return literal(first, offset, kind);
  if (isNamed(first, "url") && first.type === "function" && first.nodes[0]) return literal(first.nodes[0], offset, kind);
  return undefined;
}

export const css: Handler = {
  claims: location => location.toLowerCase().endsWith(".css"),
  analyze(text) {
    const requests: Request[] = [];
    safeParse(text).walk(node => {
      const start = node.source?.start?.offset;
      if (start === undefined) return;
      if (node.type === "decl") {
        const value = node.raws.value?.raw ?? node.value;
        urls(value, start + node.prop.length + (node.raws.between ?? "").length, requests);
      } else if (node.type === "atrule" && node.name.toLowerCase() === "import") {
        const params = node.raws.params?.raw ?? node.params;
        const found = importRequest(params, start + 1 + node.name.length + (node.raws.afterName ?? "").length);
        if (found) requests.push(found);
      }
    });
    return { requests };
  },
};
