/**
 * Wrike vendor addon.
 *
 * Wrike signs every webhook delivery with the `X-Hook-Signature` header, which
 * carries `hmacSha256(key: secret, value: request body)` computed with the
 * secret configured on the Wrike side and supplied per destination through
 * `vendorConfig.secret`.
 *
 * Wrike's documentation (https://developers.wrike.com/webhooks/) states the
 * algorithm but not the encoding of the header value, so a signature is
 * accepted when it matches either the lowercase hex or the standard base64
 * rendering of the HMAC. Both comparisons are constant time and a value that
 * matches neither is rejected.
 *
 * Registering a *secure* webhook starts with a handshake: Wrike posts
 * `{"requestType":"WebHook secret verification"}` with a random alphanumeric
 * `X-Hook-Secret` header (alongside the usual `X-Hook-Signature` over the
 * body). Once the signature is verified, the receiver must answer with
 * `X-Hook-Secret` set to `hmacSha256(key: secret, value: received X-Hook-Secret)`.
 * That handshake is answered here through `respondWith`, in the same encoding
 * the incoming signature used, and is never persisted.
 *
 * The reply echoes attacker-reachable input (the `X-Hook-Secret` header) back
 * under the destination secret, so the challenge MUST be constrained before it
 * is signed. The handshake body is a fixed constant, which makes its signature
 * a constant too: without a guard, anyone who ever observes one genuine
 * registration handshake could replay that body and signature with a chosen
 * challenge and obtain `hmacSha256(secret, arbitrary string)` - a signing
 * oracle that mints valid `X-Hook-Signature` values for forged deliveries. As
 * Wrike's documentation prescribes, a challenge longer than
 * {@link WRIKE_MAX_CHALLENGE_LENGTH} characters, or containing anything outside
 * {@link WRIKE_CHALLENGE_PATTERN} (the random alphanumeric alphabet Wrike
 * actually sends), is rejected with 400 and nothing is signed.
 */
import {
  hmacSha256Base64,
  hmacSha256Hex,
  timingSafeEqualString,
} from "../../core/ids";
import {
  isJsonArray,
  isJsonObject,
  type JsonValue,
  parseJsonText,
  readString,
} from "../../core/json";
import { AddonKind, AddonSource } from "../../storage/types";
import {
  addonAuthFailed,
  addonAuthHandled,
  addonAuthOk,
  type AddonAuthResult,
  type AddonManifest,
  type AddonModule,
  type AddonRequestContext,
  type AddonTransformContext,
  type LoadedAddon,
} from "../types";

/** Header carrying the HMAC of the request body on every delivery. */
export const WRIKE_SIGNATURE_HEADER = "x-hook-signature";

/** Header carrying the handshake challenge, and the header of the reply. */
export const WRIKE_SECRET_HEADER = "x-hook-secret";

/** Body marker of the secure-webhook registration handshake. */
export const WRIKE_VERIFICATION_REQUEST_TYPE = "WebHook secret verification";

/** Longest handshake challenge that may be signed, per Wrike's documentation. */
export const WRIKE_MAX_CHALLENGE_LENGTH = 100;

/**
 * Characters a handshake challenge may contain. Wrike sends a random
 * alphanumeric string; `.`, `_` and `-` are tolerated for forward compatibility
 * with token-shaped challenges. JSON syntax, whitespace and every other
 * character are excluded so the reply can never be a usable body signature.
 */
export const WRIKE_CHALLENGE_PATTERN = /^[A-Za-z0-9._-]+$/;

const manifest: AddonManifest = {
  name: "wrike",
  version: "1.1.1",
  kind: AddonKind.Vendor,
  description:
    "Wrike webhooks with HMAC-SHA256 signature verification via X-Hook-Signature (hex or base64), including the secure-webhook X-Hook-Secret handshake",
  entry: null,
  // Wrike posts either a single event object or an array of event objects.
  acceptsSchema: {
    anyOf: [{ type: "object" }, { type: "array", items: { type: "object" } }],
  },
  returnsSchema: {
    type: "object",
    required: ["source", "events"],
    properties: {
      source: { const: "wrike" },
      events: { type: "array", items: { type: "object" } },
    },
  },
  configSchema: {
    type: "object",
    required: ["secret"],
    properties: { secret: { type: "string", minLength: 1 } },
  },
};

type SignatureEncoding = "hex" | "base64";

/**
 * Returns the encoding whose rendering of the body HMAC matches the provided
 * signature, or null when neither does.
 */
async function matchSignature(
  secret: string,
  body: string,
  provided: string,
): Promise<SignatureEncoding | null> {
  const hex = await hmacSha256Hex(secret, body);
  if (timingSafeEqualString(provided.toLowerCase(), hex)) {
    return "hex";
  }
  const base64 = await hmacSha256Base64(secret, body);
  return timingSafeEqualString(provided, base64) ? "base64" : null;
}

async function hmacIn(
  encoding: SignatureEncoding,
  secret: string,
  value: string,
): Promise<string> {
  return encoding === "hex"
    ? hmacSha256Hex(secret, value)
    : hmacSha256Base64(secret, value);
}

/** True when the body is the secure-webhook verification challenge. */
function isVerificationRequest(rawBody: string): boolean {
  const parsed = parseJsonText(rawBody);
  if (parsed.ok === false || isJsonObject(parsed.value) === false) {
    return false;
  }
  return (
    readString(parsed.value, "requestType") === WRIKE_VERIFICATION_REQUEST_TYPE
  );
}

const addonModule: AddonModule = {
  async authenticate(ctx: AddonRequestContext): Promise<AddonAuthResult> {
    const secret = readString(ctx.config, "secret");
    if (secret === null || secret.length === 0) {
      return addonAuthFailed(
        "Destination is missing the Wrike webhook secret",
        500,
      );
    }
    const provided = ctx.headers[WRIKE_SIGNATURE_HEADER];
    if (provided === undefined || provided.trim().length === 0) {
      return addonAuthFailed("Missing X-Hook-Signature header");
    }
    const encoding = await matchSignature(secret, ctx.rawBody, provided.trim());
    if (encoding === null) {
      return addonAuthFailed("Invalid Wrike webhook signature");
    }

    if (isVerificationRequest(ctx.rawBody) === false) {
      return addonAuthOk;
    }
    const challenge = ctx.headers[WRIKE_SECRET_HEADER];
    if (challenge === undefined || challenge.length === 0) {
      return addonAuthFailed(
        "Wrike verification request is missing the X-Hook-Secret header",
        400,
      );
    }
    // The reply signs the challenge, so an unconstrained challenge would turn
    // this endpoint into a signing oracle. See the module docstring.
    if (challenge.length > WRIKE_MAX_CHALLENGE_LENGTH) {
      return addonAuthFailed(
        "Wrike verification challenge exceeds the permitted length",
        400,
      );
    }
    if (WRIKE_CHALLENGE_PATTERN.test(challenge) === false) {
      return addonAuthFailed(
        "Wrike verification challenge contains unsupported characters",
        400,
      );
    }
    return addonAuthHandled({
      status: 200,
      headers: {
        [WRIKE_SECRET_HEADER]: await hmacIn(encoding, secret, challenge),
      },
      body: null,
    });
  },

  transform(input: JsonValue, ctx: AddonTransformContext): JsonValue {
    const events = isJsonArray(input) ? input : [input];
    return {
      source: "wrike",
      receivedAt: ctx.receivedAt,
      events,
    };
  },
};

export const wrikeAddon: LoadedAddon = {
  manifest,
  module: addonModule,
  source: AddonSource.Builtin,
};
