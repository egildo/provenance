// The shipped resolvers, chosen by request scheme (specs/source-graph-kernel/research.md, Resolution).

import type { Host, Resolution, Resolver } from "./index.ts";

const hasScheme = (request: string) => /^[a-z][a-z0-9+.-]*:/i.test(request);
const isWeb = (url: string) => /^https?:/i.test(url);

/** `data:`, an empty request, and a request that is only a fragment make no edge. */
const none: Resolver = {
  claims: request => request === "" || request.startsWith("#") || /^data:/i.test(request),
  resolve: async () => null,
};

/** `http(s):` and `//host/…` are external leaves, never read. */
const external: Resolver = {
  claims: request => isWeb(request) || request.startsWith("//"),
  resolve: async request => ({ external: request.startsWith("//") ? `https:${request}` : request }),
};

/**
 * A path relative to `base`, a directory location. Query and fragment are dropped and the path is
 * percent-decoded. The one location computed is the probe; the host saying nothing is there
 * leaves the edge unresolved. A web `base` (an HTML `<base href="https://…">`) makes it external.
 */
const relative: Resolver = {
  claims: request => !hasScheme(request) && !request.startsWith("/"),
  async resolve(request, base, host) {
    if (isWeb(base)) return { external: new URL(request, base).href };
    const path = request.replace(/[?#].*$/s, "");
    let decoded = path;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      // A malformed escape stays as written.
    }
    const location = host.paths.resolve(base, decoded);
    const target = await host.canonicalize(location);
    return target === undefined ? { probes: [location] } : { probes: [location], target };
  },
};

const shipped: readonly Resolver[] = [none, external, relative];

/** Tries the embedder's resolvers first, then the shipped ones. Unclaimed means unresolved, no probes. */
export function resolve(
  request: string,
  base: string,
  host: Host,
  resolvers: readonly Resolver[] = [],
): Promise<Resolution> {
  const resolver = [...resolvers, ...shipped].find(r => r.claims(request));
  return resolver ? resolver.resolve(request, base, host) : Promise.resolve({ probes: [] });
}
