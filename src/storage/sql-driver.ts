/**
 * Minimal SQL driver port.
 *
 * Only features present in SQLite, libSQL/Turso and Cloudflare D1 are used:
 * positional `?` parameters, no stored procedures, no vendor functions.
 */

export type SqlParam = string | number | null;

export interface SqlDriver {
  run(sql: string, params?: readonly SqlParam[]): Promise<void>;
  /**
   * Runs a write and reports how many rows it affected.
   *
   * Lets a caller that needs the count of a bulk `DELETE`/`UPDATE` avoid running
   * the selection twice (once to count, once to delete), which doubles the scan
   * and holds the write lock for the duration of both.
   */
  runAffected(sql: string, params?: readonly SqlParam[]): Promise<number>;
  all<T>(sql: string, params?: readonly SqlParam[]): Promise<readonly T[]>;
  get<T>(sql: string, params?: readonly SqlParam[]): Promise<T | null>;
  /**
   * Runs `fn` inside a transaction.
   *
   * Implementations must guarantee that no other statement issued through this
   * driver runs between the transaction's start and its commit or rollback,
   * including statements issued while `fn` is awaiting. `fn` must therefore
   * issue every statement through the `tx` handle it receives; using the outer
   * driver from inside the callback is a caller error and may deadlock.
   */
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Renders `n` positional placeholders, e.g. `?, ?, ?`. */
export function placeholders(count: number): string {
  return new Array<string>(count).fill("?").join(", ");
}

/** Converts a boolean to the integer representation used in SQLite columns. */
export function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

/** Converts a stored integer column into a boolean. */
export function intToBool(value: number): boolean {
  return value !== 0;
}
