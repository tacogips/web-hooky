/**
 * GitHub vendor addon.
 *
 * GitHub signs deliveries with `X-Hub-Signature-256: sha256=<hex hmac>` over
 * the raw request body using the webhook secret.
 */
import { hmacSha256Hex, timingSafeEqualString } from "../../core/ids";
import { type JsonValue, readString } from "../../core/json";
import { AddonKind, AddonSource } from "../../storage/types";
import {
  addonAuthFailed,
  addonAuthOk,
  type AddonAuthResult,
  type AddonManifest,
  type AddonModule,
  type AddonRequestContext,
  type AddonTransformContext,
  type LoadedAddon,
} from "../types";

export const GITHUB_SIGNATURE_HEADER = "x-hub-signature-256";
export const GITHUB_EVENT_HEADER = "x-github-event";

const manifest: AddonManifest = {
  name: "github",
  version: "1.0.0",
  kind: AddonKind.Vendor,
  description:
    "GitHub webhooks with HMAC-SHA256 (hex) signature verification via X-Hub-Signature-256",
  entry: null,
  acceptsSchema: { type: "object" },
  returnsSchema: {
    type: "object",
    required: ["source", "event", "payload"],
    properties: {
      source: { const: "github" },
      event: { type: "string" },
      payload: { type: "object" },
    },
  },
  configSchema: {
    type: "object",
    required: ["secret"],
    properties: { secret: { type: "string", minLength: 1 } },
  },
};

const addonModule: AddonModule = {
  async authenticate(ctx: AddonRequestContext): Promise<AddonAuthResult> {
    const secret = readString(ctx.config, "secret");
    if (secret === null || secret.length === 0) {
      return addonAuthFailed(
        "Destination is missing the GitHub webhook secret",
        500,
      );
    }
    const provided = ctx.headers[GITHUB_SIGNATURE_HEADER];
    if (provided === undefined || provided.startsWith("sha256=") === false) {
      return addonAuthFailed("Missing or malformed X-Hub-Signature-256 header");
    }
    const expected = `sha256=${await hmacSha256Hex(secret, ctx.rawBody)}`;
    return timingSafeEqualString(provided.trim(), expected)
      ? addonAuthOk
      : addonAuthFailed("Invalid GitHub webhook signature");
  },

  transform(input: JsonValue, ctx: AddonTransformContext): JsonValue {
    return {
      source: "github",
      event: ctx.headers[GITHUB_EVENT_HEADER] ?? "unknown",
      receivedAt: ctx.receivedAt,
      payload: input,
    };
  },
};

export const githubAddon: LoadedAddon = {
  manifest,
  module: addonModule,
  source: AddonSource.Builtin,
};
