/**
 * Admin UI bundler.
 *
 * SolidJS needs its own JSX transform (`babel-preset-solid`) to produce
 * fine-grained reactive DOM updates, so `.tsx` sources are run through Babel
 * inside a Bun bundler plugin. The same function is used by `bun run build:ui`
 * and by the admin UI tests, so the tested artifact is the shipped artifact.
 */
import { transformAsync } from "@babel/core";
import solidPreset from "babel-preset-solid";
import typescriptPreset from "@babel/preset-typescript";
import type { BunPlugin } from "bun";

export const ADMIN_UI_ENTRY = new URL("./main.tsx", import.meta.url).pathname;
export const ADMIN_UI_HTML = new URL("./index.html", import.meta.url).pathname;

/** Bun plugin compiling `.tsx` sources with the SolidJS Babel preset. */
export function createSolidPlugin(): BunPlugin {
  return {
    name: "solid-jsx",
    setup(build): void {
      build.onLoad({ filter: /\.tsx$/ }, async (args) => {
        const source = await Bun.file(args.path).text();
        const result = await transformAsync(source, {
          filename: args.path,
          presets: [
            [typescriptPreset, { onlyRemoveTypeImports: true }],
            [solidPreset, {}],
          ],
          babelrc: false,
          configFile: false,
          sourceMaps: false,
        });
        if (result === null || result.code === null) {
          throw new Error(`Failed to compile ${args.path}`);
        }
        return { contents: result.code, loader: "js" };
      });
    },
  };
}

export interface BuildAdminUiOptions {
  readonly outdir?: string | undefined;
  readonly minify?: boolean | undefined;
  readonly format?: "esm" | "iife" | undefined;
}

/** Builds the admin UI bundle; returns the generated JavaScript. */
export async function buildAdminUi(
  options: BuildAdminUiOptions = {},
): Promise<string> {
  const result = await Bun.build({
    entrypoints: [ADMIN_UI_ENTRY],
    target: "browser",
    format: options.format ?? "esm",
    minify: options.minify ?? false,
    plugins: [createSolidPlugin()],
    ...(options.outdir === undefined ? {} : { outdir: options.outdir }),
  });

  if (result.success === false) {
    throw new Error(
      `Admin UI build failed: ${result.logs.map(String).join("; ")}`,
    );
  }
  const output = result.outputs[0];
  if (output === undefined) {
    throw new Error("Admin UI build produced no output");
  }
  return output.text();
}
