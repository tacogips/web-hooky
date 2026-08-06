/**
 * The `webhooky` command line interface.
 *
 * Every capability offered here is one call into this package, so anything
 * scriptable at the command line is equally available to a Node program.
 * Output is JSON on stdout; diagnostics go to stderr.
 *
 * Exit codes: 0 success, 1 the request failed, 2 the command was invoked
 * wrongly.
 */
import { WebhookyError } from "../errors.js";
import { runAdmin } from "./admin.js";
import { booleanFlag, parseCommandLine, type ParsedArgs } from "./args.js";
import { CLI_USER_AGENT, UsageError } from "./env.js";
import { runRecords } from "./records.js";
import { USAGE } from "./usage.js";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

async function dispatch(args: ParsedArgs): Promise<void> {
  const pretty = booleanFlag(args, "pretty");
  const group = args.positionals[0];

  switch (group) {
    case "records":
      return runRecords(args.positionals[1], args, pretty);
    case "admin":
      return runAdmin(args.positionals.slice(1), args, pretty);
    default:
      throw new UsageError(`unknown command group "${String(group)}"`);
  }
}

/** Runs one CLI invocation and resolves to the process exit code. */
export async function run(argv: readonly string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseCommandLine(argv);
  } catch (error) {
    process.stderr.write(`webhooky: ${(error as Error).message}\n`);
    return EXIT_USAGE;
  }

  if (booleanFlag(args, "version")) {
    process.stdout.write(`${CLI_USER_AGENT}\n`);
    return EXIT_OK;
  }
  if (booleanFlag(args, "help") || args.positionals.length === 0) {
    process.stdout.write(USAGE);
    return args.positionals.length === 0 && booleanFlag(args, "help") === false
      ? EXIT_USAGE
      : EXIT_OK;
  }

  try {
    await dispatch(args);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`webhooky: ${error.message}\n`);
      process.stderr.write('Run "webhooky --help" for usage.\n');
      return EXIT_USAGE;
    }
    if (error instanceof WebhookyError) {
      process.stderr.write(`${JSON.stringify(error.toJSON())}\n`);
      return EXIT_FAILURE;
    }
    // An EPIPE means `webhooky records stream | head` closed stdout under us;
    // that is the pipeline working, not a failure.
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "EPIPE"
    ) {
      return EXIT_OK;
    }
    process.stderr.write(
      `webhooky: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT_FAILURE;
  }
  return EXIT_OK;
}

/** Entry point used by `bin/webhooky.js`. */
export async function main(): Promise<void> {
  // Ctrl-C during a stream is a normal way to stop.
  process.on("SIGINT", () => process.exit(EXIT_OK));
  process.exitCode = await run(process.argv.slice(2));
}
