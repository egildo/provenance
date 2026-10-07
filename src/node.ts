// The Node host: the only module that imports `node:` (design principle: Supply, not meaning).

import { promises as fs, watch as watchDirectory } from "node:fs";
import type { FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Host } from "./index.ts";

let counter = 0;

export function createNodeHost({ debounce = 300 }: { debounce?: number } = {}): Host {
  return {
    paths: {
      separator: path.sep,
      homeDirectory: os.homedir(),
      dirname: path.dirname,
      isAbsolute: path.isAbsolute,
      resolve: (base, segment) => (segment === undefined ? path.resolve(base) : path.resolve(base, segment)),
    },

    async read(location) {
      try {
        return { ok: true, bytes: await fs.readFile(location) };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },

    /** Atomic per file: a temporary file in the same directory, then a rename over the target. */
    async write(location, bytes) {
      const temporary = path.join(path.dirname(location), `.${path.basename(location)}.${process.pid}.${(counter += 1)}.tmp`);
      try {
        const mode = await fs.stat(location).then(stat => stat.mode, () => undefined);
        await fs.writeFile(temporary, bytes);
        if (mode !== undefined) await fs.chmod(temporary, mode);
        await fs.rename(temporary, location);
        return { ok: true };
      } catch (error) {
        await fs.rm(temporary, { force: true });
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },

    async canonicalize(location) {
      try {
        return await fs.realpath(location);
      } catch {
        return undefined;
      }
    },

    /**
     * Watches the parent directory of each location, not the file: a file watch follows its inode
     * and misses an editor's write-then-rename save. Events are debounced into one batch.
     */
    watch(onChange) {
      let watched = new Set<string>();
      const directories = new Map<string, FSWatcher>();
      let pending = new Set<string>();
      let timer: ReturnType<typeof setTimeout> | undefined;

      const flush = () => {
        timer = undefined;
        const batch = [...pending];
        pending = new Set();
        if (batch.length > 0) onChange(batch);
      };

      const heard = (directory: string, filename: string | null) => {
        for (const location of watched) {
          if (path.dirname(location) !== directory) continue;
          // Some platforms do not say which file changed; then every watched file there may have.
          if (filename === null || path.basename(location) === filename) pending.add(location);
        }
        if (pending.size === 0) return;
        clearTimeout(timer);
        timer = setTimeout(flush, debounce);
      };

      const stop = (directory: string) => {
        directories.get(directory)?.close();
        directories.delete(directory);
      };

      return {
        set(locations) {
          watched = new Set(locations);
          const needed = new Set(locations.map(location => path.dirname(location)));
          for (const directory of directories.keys()) if (!needed.has(directory)) stop(directory);
          for (const directory of needed) {
            if (directories.has(directory)) continue;
            try {
              const watcher = watchDirectory(directory, (_event, filename) => heard(directory, filename));
              watcher.on("error", () => stop(directory));
              directories.set(directory, watcher);
            } catch {
              // ponytail: a directory that does not exist yet is not watched, so a probe inside it
              // heals only on the next event elsewhere. Watch the nearest existing ancestor if needed.
            }
          }
        },
        close() {
          clearTimeout(timer);
          for (const directory of [...directories.keys()]) stop(directory);
          watched = new Set();
        },
      };
    },
  };
}
