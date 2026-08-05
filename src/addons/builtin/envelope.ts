/**
 * Envelope destination-level addon.
 *
 * Wraps the vendor addon output with receipt metadata and an optional label
 * taken from the destination configuration. Demonstrates the destination-level
 * stage that runs after the vendor stage.
 */
import { type JsonValue, readString } from "../../core/json";
import { AddonKind, AddonSource } from "../../storage/types";
import type {
  AddonManifest,
  AddonModule,
  AddonTransformContext,
  LoadedAddon,
} from "../types";

const manifest: AddonManifest = {
  name: "envelope",
  version: "1.0.0",
  kind: AddonKind.Destination,
  description: "Wraps the payload with receipt metadata and an optional label",
  entry: null,
  acceptsSchema: true,
  returnsSchema: {
    type: "object",
    required: ["label", "receivedAt", "data"],
    properties: {
      label: { type: "string" },
      receivedAt: { type: "integer" },
      data: true,
    },
  },
  configSchema: {
    type: "object",
    properties: { label: { type: "string" } },
  },
};

const addonModule: AddonModule = {
  transform(input: JsonValue, ctx: AddonTransformContext): JsonValue {
    return {
      label: readString(ctx.config, "label") ?? ctx.destinationId,
      receivedAt: ctx.receivedAt,
      data: input,
    };
  },
};

export const envelopeAddon: LoadedAddon = {
  manifest,
  module: addonModule,
  source: AddonSource.Builtin,
};
