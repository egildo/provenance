// The HTML handler: the attributes that make a browser load something, found with parse5
// (specs/source-graph-kernel/contracts/public-api.md, Handlers). `<style>` and `style="…"` are
// CSS regions, not this handler's language, and wait for regions.

import { parse } from "parse5";
import type { DefaultTreeAdapterTypes as Tree } from "parse5";
import type { Findings, Handler } from "./index.ts";

type Request = Findings["requests"][number];
type Kind = Request["kind"];

/** The value's range inside an attribute's `name="value"` span, or undefined for a bare name. */
function valueRange(text: string, span: { startOffset: number; endOffset: number }) {
  const raw = text.slice(span.startOffset, span.endOffset);
  const head = /^[^\s=]+\s*=\s*(["']?)\s*/.exec(raw);
  if (!head) return undefined;
  const quoted = head[1] !== "" && raw.endsWith(head[1]) && raw.length > head[0].length;
  const value = raw.slice(head[0].length, raw.length - (quoted ? 1 : 0));
  return { start: span.startOffset + head[0].length, end: span.startOffset + head[0].length + value.trimEnd().length };
}

/**
 * The URL ranges in a `srcset`, per the HTML standard's "parse a srcset attribute": a URL is a
 * run of non-whitespace; trailing commas end it; descriptors run to a comma outside parentheses.
 */
function srcsetUrls(value: string): { start: number; end: number }[] {
  const urls: { start: number; end: number }[] = [];
  const space = /[\t\n\f\r ]/;
  let i = 0;
  while (i < value.length) {
    while (i < value.length && (space.test(value[i]) || value[i] === ",")) i++;
    if (i >= value.length) break;
    const start = i;
    while (i < value.length && !space.test(value[i])) i++;
    let end = i;
    if (value[end - 1] === ",") {
      while (end > start && value[end - 1] === ",") end--;
    } else {
      let depth = 0;
      while (i < value.length && !(value[i] === "," && depth === 0)) {
        if (value[i] === "(") depth++;
        else if (value[i] === ")" && depth > 0) depth--;
        i++;
      }
    }
    if (end > start) urls.push({ start, end });
  }
  return urls;
}

/** Which attributes of an element load something, and how surely. */
function loads(element: Tree.Element): [attribute: string, kind: Kind, srcset?: true][] {
  const attr = (name: string) => element.attrs.find(a => a.name === name && !a.prefix)?.value;
  const lazy = attr("loading")?.toLowerCase() === "lazy";
  switch (element.tagName) {
    case "link": {
      const rel = (attr("rel") ?? "").toLowerCase().split(/\s+/);
      if (rel.includes("stylesheet")) {
        return [["href", attr("media") !== undefined || rel.includes("alternate") ? "candidate" : "requires"]];
      }
      return ["icon", "preload", "modulepreload", "prefetch"].some(r => rel.includes(r)) ? [["href", "candidate"]] : [];
    }
    case "img":
      return [["src", lazy ? "candidate" : "requires"], ["srcset", "candidate", true]];
    case "iframe":
      return [["src", lazy ? "candidate" : "requires"]];
    case "source":
      return [["src", "candidate"], ["srcset", "candidate", true]];
    case "video":
      return [["src", "candidate"], ["poster", "candidate"]];
    case "audio":
      return [["src", "candidate"]];
    case "object":
      return [["data", "requires"]];
    case "script":
      return [["src", "requires"]];
    case "use":
      return [["href", "requires"], ["xlink:href", "requires"]];
    default:
      return [];
  }
}

export const html: Handler = {
  claims: location => /\.html?$/i.test(location),
  analyze(text) {
    const requests: Request[] = [];
    let base: string | undefined;

    const visit = (node: Tree.ParentNode | Tree.ChildNode) => {
      if ("tagName" in node) {
        if (node.tagName === "base" && base === undefined) {
          base = node.attrs.find(a => a.name === "href" && !a.prefix)?.value;
        }
        for (const [name, kind, isSrcset] of loads(node)) {
          const attribute = node.attrs.find(a => (a.prefix ? `${a.prefix}:${a.name}` : a.name) === name);
          const span = node.sourceCodeLocation?.attrs?.[name];
          const range = attribute && span && valueRange(text, span);
          if (!attribute || !range) continue;
          if (!isSrcset) {
            requests.push({ ...range, request: attribute.value.trim(), kind });
            continue;
          }
          // The ranges come from the text as written, the requests from the decoded value; they
          // pair up unless an entity changed where a comma or a space falls.
          const written = srcsetUrls(text.slice(range.start, range.end));
          const decoded = srcsetUrls(attribute.value);
          if (written.length !== decoded.length) continue;
          written.forEach((w, k) => {
            requests.push({
              start: range.start + w.start,
              end: range.start + w.end,
              request: attribute.value.slice(decoded[k].start, decoded[k].end),
              kind,
            });
          });
        }
      }
      if ("childNodes" in node) for (const child of node.childNodes) visit(child);
      if ("content" in node) visit(node.content);
    };

    visit(parse(text, { sourceCodeLocationInfo: true }));
    return base === undefined ? { requests } : { requests, base };
  },
};
