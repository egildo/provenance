// An in-memory host for any realm: POSIX paths, files held as bytes, events at the next microtask.

import type { Host, HostReadResult, PathFacility } from "./index.ts";

const paths: PathFacility = {
  separator: "/",
  homeDirectory: undefined,
  dirname(path) {
    const cut = path.replace(/\/+$/, "").lastIndexOf("/");
    return cut > 0 ? path.slice(0, cut) : cut === 0 ? "/" : ".";
  },
  isAbsolute: path => path.startsWith("/"),
  resolve(base, segment) {
    const joined = segment?.startsWith("/") ? segment : `${base}/${segment ?? ""}`;
    const parts: string[] = [];
    for (const part of joined.split("/")) {
      if (part === "..") parts.pop();
      else if (part !== "" && part !== ".") parts.push(part);
    }
    return `/${parts.join("/")}`;
  },
};

export function createMemoryHost(files: Record<string, string | Uint8Array> = {}): Host & {
  write(location: string, content: string | Uint8Array): void;
  remove(location: string): void;
  refuse(location: string, reason: string): void;
} {
  const store = new Map<string, Uint8Array>();
  const refused = new Map<string, string>();
  const watchers = new Set<{ watched: Set<string>; onChange: (locations: readonly string[]) => void }>();
  let pending = new Set<string>();

  const at = (location: string) => paths.resolve("/", location);
  const toBytes = (content: string | Uint8Array) =>
    typeof content === "string" ? new TextEncoder().encode(content) : content;

  function notify(location: string) {
    if (pending.size === 0) queueMicrotask(deliver);
    pending.add(location);
  }

  function deliver() {
    const batch = [...pending];
    pending = new Set();
    for (const { watched, onChange } of watchers) {
      const mine = batch.filter(location => watched.has(location));
      if (mine.length > 0) onChange(mine);
    }
  }

  for (const [location, content] of Object.entries(files)) store.set(at(location), toBytes(content));

  return {
    paths,
    async read(location): Promise<HostReadResult> {
      const key = at(location);
      const reason = refused.get(key);
      if (reason !== undefined) return { ok: false, reason };
      const bytes = store.get(key);
      return bytes ? { ok: true, bytes } : { ok: false, reason: "not found" };
    },
    async canonicalize(location) {
      const key = at(location);
      return store.has(key) || refused.has(key) ? key : undefined;
    },
    watch(onChange) {
      const watcher = { watched: new Set<string>(), onChange };
      watchers.add(watcher);
      return {
        set: locations => void (watcher.watched = new Set(locations.map(at))),
        close: () => void watchers.delete(watcher),
      };
    },
    write(location, content) {
      store.set(at(location), toBytes(content));
      notify(at(location));
    },
    remove(location) {
      store.delete(at(location));
      refused.delete(at(location));
      notify(at(location));
    },
    refuse(location, reason) {
      refused.set(at(location), reason);
      notify(at(location));
    },
  };
}
