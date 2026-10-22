import os from "node:os";
import path from "node:path";
import { resolveCacheDir } from "@epoch-dev/core";
import { SqliteCacheStore } from "./sqlite-store.js";

/** The per-user cache directory for this process (EPOCH_CACHE_DIR, else the OS convention). */
export function defaultCacheDir(): string {
  return path.resolve(
    resolveCacheDir({
      platform: process.platform,
      env: process.env,
      homedir: os.homedir(),
    }),
  );
}

/** Opens the shared SQLite cache (ADR-004). */
export function openCache(dir: string = defaultCacheDir()): SqliteCacheStore {
  return SqliteCacheStore.open(dir);
}
