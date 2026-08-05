/**
 * Passthrough addon.
 *
 * Accepts any JSON body without authentication and returns it unchanged. Useful
 * for internal producers, for local testing, and as a destination-level no-op.
 * Because it performs no authentication it should only be attached to
 * destinations whose inbound UUID is treated as a bearer secret.
 */
import type { JsonValue } from "../../core/json";
import { AddonKind, AddonSource } from "../../storage/types";
import type { AddonManifest, AddonModule, LoadedAddon } from "../types";

const manifest: AddonManifest = {
  name: "passthrough",
  version: "1.0.0",
  kind: AddonKind.Both,
  description: "Accepts any JSON payload unchanged and without authentication",
  entry: null,
  acceptsSchema: true,
  returnsSchema: true,
  configSchema: null,
};

const addonModule: AddonModule = {
  transform(input: JsonValue): JsonValue {
    return input;
  },
};

export const passthroughAddon: LoadedAddon = {
  manifest,
  module: addonModule,
  source: AddonSource.Builtin,
};
