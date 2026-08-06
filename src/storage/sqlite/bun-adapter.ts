/**
 * Bun-specific persistence factory.
 *
 * Kept apart from `adapter.ts` so that importing the driver-agnostic
 * `createSqlPersistenceAdapter` does not drag `bun:sqlite` into the module
 * graph. A bundler resolves imports statically, so a Workers build fails on the
 * `bun:sqlite` specifier even when the factory is never called - which is
 * exactly what happened before this split.
 */
import type { PersistenceAdapter } from "../persistence";
import { createSqlPersistenceAdapter } from "./adapter";
import { createBunSqliteDriver } from "./bun-driver";

/** Convenience factory for the local Bun runtime. */
export function createBunSqlitePersistence(path: string): PersistenceAdapter {
  return createSqlPersistenceAdapter(createBunSqliteDriver(path));
}
