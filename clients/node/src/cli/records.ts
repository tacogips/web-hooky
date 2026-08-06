/**
 * The `webhooky records ...` command group.
 */
import type { RecordQuery } from "../types.js";
import {
  booleanFlag,
  buildFetchClient,
  emit,
  numberFlag,
  type ParsedArgs,
  stringFlag,
} from "./args.js";
import { resolveFetchUuid, UsageError } from "./env.js";

function buildQuery(args: ParsedArgs): RecordQuery {
  const query: {
    onlyUnfetched?: boolean;
    markFetched?: boolean;
    from?: string;
    to?: string;
    limit?: number;
  } = {};

  if (booleanFlag(args, "only-unfetched")) {
    query.onlyUnfetched = true;
  }
  if (booleanFlag(args, "no-mark-fetched")) {
    query.markFetched = false;
  }
  const from = stringFlag(args, "from");
  if (from !== undefined) {
    query.from = from;
  }
  const to = stringFlag(args, "to");
  if (to !== undefined) {
    query.to = to;
  }
  const limit = numberFlag(args, "limit");
  if (limit !== undefined) {
    query.limit = limit;
  }
  return query;
}

async function runGet(args: ParsedArgs, pretty: boolean): Promise<void> {
  const fetchUuid = resolveFetchUuid(stringFlag(args, "fetch-uuid"));
  const client = buildFetchClient(args);
  emit(await client.records(fetchUuid, buildQuery(args)), pretty);
}

async function runStream(args: ParsedArgs): Promise<void> {
  const fetchUuid = resolveFetchUuid(stringFlag(args, "fetch-uuid"));
  const client = buildFetchClient(args);
  const maxRecords = numberFlag(args, "max-records");

  const options = {
    reconnect: booleanFlag(args, "reconnect"),
    ...(maxRecords !== undefined && maxRecords > 0 ? { maxRecords } : {}),
    // Progress goes to stderr so stdout stays a clean record stream.
    onReady: (): void => {
      process.stderr.write(`webhooky: streaming ${fetchUuid}\n`);
    },
    onReconnect: (attempt: number, cause: unknown): void => {
      const message = cause instanceof Error ? cause.message : String(cause);
      process.stderr.write(
        `webhooky: reconnect attempt ${attempt} after: ${message}\n`,
      );
    },
  };

  for await (const record of client.stream(fetchUuid, options)) {
    // One record per line so the stream composes with `jq` and `head`.
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
}

export async function runRecords(
  command: string | undefined,
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  switch (command) {
    case "get":
      return runGet(args, pretty);
    case "stream":
      return runStream(args);
    default:
      throw new UsageError('expected "records get" or "records stream"');
  }
}
