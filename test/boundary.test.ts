import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// Design principle "Supply, not meaning": no platform import outside the Node host, and each
// parser only inside the handler that needs it, so an embedder loads only what it uses.

const src = new URL("../src/", import.meta.url);
const files = readdirSync(src).filter(name => name.endsWith(".ts"));

function imports(file: string): string[] {
  const text = readFileSync(new URL(file, src), "utf8");
  return [...text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map(
    match => match[1] ?? match[2],
  );
}

const allowed: Record<string, (specifier: string) => boolean> = {
  "node.ts": specifier => specifier.startsWith("node:"),
  "html.ts": specifier => specifier === "parse5",
  "css.ts": specifier => specifier.startsWith("postcss"),
};

test("every source file imports only relative paths, plus what its role allows", () => {
  assert.ok(files.includes("session.ts") && files.includes("node.ts"));
  for (const file of files) {
    for (const specifier of imports(file)) {
      const ok = specifier.startsWith("./") || allowed[file]?.(specifier) === true;
      assert.ok(ok, `${file} imports ${specifier}`);
    }
  }
});

test("the check itself sees imports", () => {
  assert.ok(imports("node.ts").some(s => s.startsWith("node:")));
  assert.ok(imports("css.ts").includes("postcss-safe-parser"));
});

// Joining FR-001: Cascata is a development dependency only. The libraries meet by shape.
test("Cascata is a development dependency, and nothing under src/ names it", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.match(manifest.devDependencies?.["@egildo/cascata"] ?? "", /^\^1\.11\./);
  assert.equal(manifest.dependencies?.["@egildo/cascata"], undefined);
  for (const file of files) {
    assert.ok(!readFileSync(new URL(file, src), "utf8").includes("@egildo/cascata"), `${file} mentions @egildo/cascata`);
  }
});
