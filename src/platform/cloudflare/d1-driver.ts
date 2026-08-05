/**
 * Cloudflare D1 implementation of the SQL driver port.
 *
 * D1 has no interactive transactions. It "operates in auto-commit"; the only
 * transactional primitive is `batch()`, which commits an array of statements
 * that must be known up front. A read-then-await-then-write sequence - which is
 * what `SqlDriver.transaction(fn)` exists for - cannot be expressed that way,
 * because the write's parameters come from the read's results.
 *
 * `transaction()` therefore throws here rather than degrading to a sequence of
 * auto-committed statements. Accepting a silent degradation would reintroduce
 * exactly the two failures recorded in design-docs/specs/notes.md: two
 * concurrent `only_unfetched` readers receiving the same records, and two relay
 * workers claiming the same delivery. Losing an isolation guarantee has to be a
 * compile-time or startup-time event, never a silent runtime one.
 *
 * The store layer does not call `transaction()`: the three operations that used
 * to need it were rewritten as single atomic statements (`UPDATE ... RETURNING`
 * and `runAffected`), which auto-commit correctly on D1 and remain correct on
 * `bun:sqlite`. This method exists to keep the port total, and to fail loudly if
 * a future caller reaches for it.
 */
import type { SqlDriver, SqlParam } from "../../storage/sql-driver";

/**
 * The subset of D1's binding surface this driver uses.
 *
 * Declared structurally so the module does not depend on
 * `@cloudflare/workers-types` at runtime, and so tests can supply a double.
 */
export interface D1PreparedStatementLike {
  bind(...values: readonly SqlParam[]): D1PreparedStatementLike;
  all<T>(): Promise<{ readonly results: readonly T[] }>;
  run(): Promise<{ readonly meta: { readonly changes?: number } }>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
}

/** Binds only when there are parameters; D1 rejects an empty `bind()`. */
function prepare(
  db: D1DatabaseLike,
  sql: string,
  params: readonly SqlParam[],
): D1PreparedStatementLike {
  const statement = db.prepare(sql);
  return params.length === 0 ? statement : statement.bind(...params);
}

/** Creates a driver backed by a D1 database binding. */
export function createD1Driver(db: D1DatabaseLike): SqlDriver {
  return {
    async run(sql: string, params: readonly SqlParam[] = []): Promise<void> {
      await prepare(db, sql, params).run();
    },

    async runAffected(
      sql: string,
      params: readonly SqlParam[] = [],
    ): Promise<number> {
      const result = await prepare(db, sql, params).run();
      return result.meta.changes ?? 0;
    },

    async all<T>(
      sql: string,
      params: readonly SqlParam[] = [],
    ): Promise<readonly T[]> {
      const result = await prepare(db, sql, params).all<T>();
      return result.results;
    },

    async get<T>(
      sql: string,
      params: readonly SqlParam[] = [],
    ): Promise<T | null> {
      // `first()` is deliberately not used: it is one more shape to keep in
      // step with the double used by the tests, and the callers all select a
      // single row anyway.
      const result = await prepare(db, sql, params).all<T>();
      return result.results[0] ?? null;
    },

    transaction<T>(): Promise<T> {
      return Promise.reject(
        new Error(
          "Cloudflare D1 does not support interactive transactions. " +
            "Express the operation as a single atomic statement " +
            "(UPDATE ... RETURNING, or runAffected) instead; see " +
            "src/storage/d1/driver.ts for why this is not degraded silently.",
        ),
      );
    },

    close(): Promise<void> {
      // D1 bindings are managed by the runtime and outlive a single request.
      return Promise.resolve();
    },
  };
}
