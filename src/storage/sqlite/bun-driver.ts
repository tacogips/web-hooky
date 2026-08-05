/**
 * `bun:sqlite` implementation of the SQL driver port.
 *
 * `bun:sqlite` executes synchronously but the port is async, so *every*
 * statement - not only transactions - is serialized through a single FIFO
 * promise queue. Anything less is unsound: an `await` inside a transaction
 * callback yields the JavaScript thread, and any statement that runs during
 * that gap would execute on the same connection between BEGIN and COMMIT. That
 * would let two `only_unfetched` readers claim the same record and would let an
 * unrelated rollback discard a write that was already acknowledged.
 *
 * Consequence for callers: inside `transaction(fn)` every statement must go
 * through the `tx` handle passed to `fn`. Reaching for the outer driver from
 * within a transaction callback deadlocks, because the queue slot is held for
 * the whole BEGIN..COMMIT span.
 */
import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { SqlDriver, SqlParam } from "../sql-driver";

function toBindings(params: readonly SqlParam[]): SQLQueryBindings[] {
  // SqlParam is a strict subset of SQLQueryBindings.
  return params as SQLQueryBindings[];
}

/** Creates a driver backed by a SQLite file (or `:memory:`). */
export function createBunSqliteDriver(path: string): SqlDriver {
  const db = new Database(path, { create: true });
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  let queue: Promise<unknown> = Promise.resolve();

  /**
   * Appends `task` to the FIFO queue. The chain is continued on both settle
   * paths so one failing statement cannot stall every later caller.
   */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // Direct execution helpers. They are reached only while the queue slot is
  // held, either by an enqueued statement or by an open transaction.
  function runNow(
    sql: string,
    params: readonly SqlParam[] = [],
  ): Promise<void> {
    db.query(sql).run(...toBindings(params));
    return Promise.resolve();
  }

  function runAffectedNow(
    sql: string,
    params: readonly SqlParam[] = [],
  ): Promise<number> {
    const changes = db.query(sql).run(...toBindings(params));
    return Promise.resolve(changes.changes);
  }

  function allNow<T>(
    sql: string,
    params: readonly SqlParam[] = [],
  ): Promise<readonly T[]> {
    return Promise.resolve(db.query(sql).all(...toBindings(params)) as T[]);
  }

  function getNow<T>(
    sql: string,
    params: readonly SqlParam[] = [],
  ): Promise<T | null> {
    const row = db.query(sql).get(...toBindings(params)) as T | null;
    return Promise.resolve(row ?? null);
  }

  /**
   * Ends a failed transaction. A ROLLBACK that itself fails (SQLite already
   * rolled the transaction back on its own) must not replace the error that
   * caused it, which is the one the caller can act on.
   */
  function rollbackQuietly(): void {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Intentionally ignored; see above.
    }
  }

  /**
   * Driver view handed to transaction callbacks. It runs statements directly
   * (the queue slot is already held) and never opens a nested transaction:
   * SQLite has no nested BEGIN, and the callback is already atomic.
   */
  const inner: SqlDriver = {
    run: runNow,
    runAffected: runAffectedNow,
    all: allNow,
    get: getNow,
    transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
      return fn(inner);
    },
    close(): Promise<void> {
      return Promise.reject(
        new Error("close() must not be called inside a transaction"),
      );
    },
  };

  return {
    run(sql: string, params: readonly SqlParam[] = []): Promise<void> {
      return enqueue(() => runNow(sql, params));
    },

    runAffected(
      sql: string,
      params: readonly SqlParam[] = [],
    ): Promise<number> {
      return enqueue(() => runAffectedNow(sql, params));
    },

    all<T>(
      sql: string,
      params: readonly SqlParam[] = [],
    ): Promise<readonly T[]> {
      return enqueue(() => allNow<T>(sql, params));
    },

    get<T>(sql: string, params: readonly SqlParam[] = []): Promise<T | null> {
      return enqueue(() => getNow<T>(sql, params));
    },

    transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
      return enqueue(async () => {
        db.exec("BEGIN IMMEDIATE");
        let result: T;
        try {
          result = await fn(inner);
        } catch (error) {
          rollbackQuietly();
          throw error;
        }
        try {
          db.exec("COMMIT");
        } catch (error) {
          // A commit failure is its own error, not the callback's: reporting it
          // separately keeps "the work failed" distinguishable from "the work
          // succeeded but could not be persisted".
          rollbackQuietly();
          throw error;
        }
        return result;
      });
    },

    close(): Promise<void> {
      return enqueue(() => {
        db.close();
        return Promise.resolve();
      });
    },
  };
}
