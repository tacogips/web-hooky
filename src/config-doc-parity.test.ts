/**
 * Documentation / implementation parity for the configuration surface.
 *
 * This suite exists because line coverage cannot catch a flag that was never
 * written: `--admin-auth-shared-secret` was documented in
 * `design-docs/specs/command.md` as the mitigation for trusted-header spoofing
 * while being absent from `FLAG_TO_ENV`, so following the hardening
 * instructions aborted startup with "Unknown flag". Both directions are
 * asserted - documented things must exist, existing things must be documented -
 * so the drift cannot reappear from either side.
 */
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { FLAG_TO_ENV, parseArgv, USAGE } from "./config";

const SPEC_PATH = join(import.meta.dir, "../design-docs/specs/command.md");
const CONFIG_PATH = join(import.meta.dir, "config.ts");

const spec = await Bun.file(SPEC_PATH).text();
const configSource = await Bun.file(CONFIG_PATH).text();

/** Flags documented in the command.md flags table, e.g. `` | `--host <host>` | ``. */
function documentedFlags(): readonly string[] {
  return [...spec.matchAll(/^\| `(--[a-z][a-z-]*)[ <`]/gm)]
    .map((match) => match[1] ?? "")
    .filter((flag) => flag !== "--help");
}

/** Variables documented in the command.md environment table. */
function documentedEnvVars(): readonly string[] {
  return [...spec.matchAll(/^\| `(WEBHOOKY_[A-Z_]+)`/gm)].map(
    (match) => match[1] ?? "",
  );
}

/** Every `WEBHOOKY_*` name the implementation mentions. */
function implementedEnvVars(): ReadonlySet<string> {
  return new Set(
    [...configSource.matchAll(/WEBHOOKY_[A-Z_]+/g)].map((match) => match[0]),
  );
}

describe("command.md / config.ts parity", () => {
  test("the tables are actually being parsed", () => {
    // Guards the guard: if the table format changes and the regexes stop
    // matching, this fails instead of every assertion passing vacuously.
    expect(documentedFlags().length).toBeGreaterThan(20);
    expect(documentedEnvVars().length).toBeGreaterThan(20);
  });

  test("every documented flag is accepted by the parser", () => {
    for (const flag of documentedFlags()) {
      const parsed = parseArgv([flag, "value"]);
      expect(parsed.ok, `${flag} is documented but rejected`).toBe(true);
    }
  });

  test("every implemented flag is documented", () => {
    const documented = new Set(documentedFlags());
    for (const flag of FLAG_TO_ENV.keys()) {
      expect(
        documented.has(flag),
        `${flag} is implemented but undocumented`,
      ).toBe(true);
    }
  });

  test("every implemented flag appears in the --help text", () => {
    for (const flag of FLAG_TO_ENV.keys()) {
      expect(USAGE.includes(`${flag} `), `${flag} is missing from USAGE`).toBe(
        true,
      );
    }
  });

  test("every documented environment variable is read by config.ts", () => {
    const implemented = implementedEnvVars();
    for (const name of documentedEnvVars()) {
      expect(
        implemented.has(name),
        `${name} is documented but never read`,
      ).toBe(true);
    }
  });

  test("every environment variable config.ts reads is documented", () => {
    const documented = new Set(documentedEnvVars());
    for (const name of implementedEnvVars()) {
      expect(
        documented.has(name),
        `${name} is implemented but undocumented in command.md`,
      ).toBe(true);
    }
  });

  test("every flag maps to a documented environment variable", () => {
    const documented = new Set(documentedEnvVars());
    for (const [flag, envKey] of FLAG_TO_ENV) {
      expect(
        documented.has(envKey),
        `${flag} maps to undocumented ${envKey}`,
      ).toBe(true);
    }
  });
});
