/**
 * Clock abstraction so time dependent behaviour (retention, receipt timestamps)
 * stays testable.
 */

export interface Clock {
  /** Current unix time in whole seconds. */
  nowSeconds(): number;
  /** Current unix time in milliseconds. */
  nowMs(): number;
}

export const systemClock: Clock = {
  nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  },
  nowMs(): number {
    return Date.now();
  },
};

/** Creates a clock whose time is advanced manually; used by tests. */
export function createFixedClock(startSeconds: number): Clock & {
  advance(seconds: number): void;
} {
  let current = startSeconds;
  return {
    nowSeconds(): number {
      return current;
    },
    nowMs(): number {
      return current * 1000;
    },
    advance(seconds: number): void {
      current += seconds;
    },
  };
}

/**
 * Parses a receipt datetime bound expressed either as unix seconds or as an
 * ISO-8601 timestamp. Returns null when the value cannot be interpreted.
 */
export function parseTimeBound(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (/^-?\d+$/.test(trimmed)) {
    const numeric = Number.parseInt(trimmed, 10);
    return Number.isFinite(numeric) ? numeric : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}
