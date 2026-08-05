/**
 * `babel-preset-solid` ships without type declarations.
 *
 * The preset is a Babel preset factory: `(api, options, dirname) => preset`.
 */
declare module "babel-preset-solid" {
  import type { PresetAPI, PresetObject } from "@babel/core";

  const preset: (
    api: PresetAPI,
    options: object,
    dirname: string,
  ) => PresetObject;
  export default preset;
}
