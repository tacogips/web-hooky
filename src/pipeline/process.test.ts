import { describe, expect, test } from "bun:test";
import { envelopeAddon } from "../addons/builtin/envelope";
import { passthroughAddon } from "../addons/builtin/passthrough";
import { wrikeAddon } from "../addons/builtin/wrike";
import type { AddonManifest, LoadedAddon } from "../addons/types";
import { AppErrorKind } from "../core/errors";
import { hmacSha256Hex } from "../core/ids";
import type { JsonValue } from "../core/json";
import {
  AddonKind,
  AddonSource,
  type DestinationRecord,
} from "../storage/types";
import { InboundOutcomeKind, processInboundWebhook } from "./process";

const destination: DestinationRecord = {
  id: "dest-1",
  name: "Test",
  vendorAddon: "wrike",
  destinationAddon: null,
  inboundUuid: "inbound",
  fetchUuid: "fetch",
  vendorConfig: { secret: "shhh" },
  destinationConfig: { label: "team" },
  retentionSeconds: null,
  enabled: true,
  createdAt: 0,
  createdBy: null,
};

function manifest(overrides: Partial<AddonManifest> = {}): AddonManifest {
  return {
    name: "test-addon",
    version: "1.0.0",
    kind: AddonKind.Both,
    description: "",
    entry: null,
    acceptsSchema: true,
    returnsSchema: true,
    configSchema: null,
    ...overrides,
  };
}

async function signedWrikeBody(
  payload: JsonValue,
): Promise<{ rawBody: string; headers: Record<string, string> }> {
  const rawBody = JSON.stringify(payload);
  return {
    rawBody,
    headers: { "x-hook-signature": await hmacSha256Hex("shhh", rawBody) },
  };
}

/** Reads the persisted payload of a successful pipeline run. */
function persistedPayload(
  result: Awaited<ReturnType<typeof processInboundWebhook>>,
): JsonValue | null {
  if (result.ok === false || result.value.kind !== InboundOutcomeKind.Persist) {
    return null;
  }
  return result.value.payload;
}

describe("processInboundWebhook", () => {
  test("accepts a signed payload and applies the vendor transform", async () => {
    const { rawBody, headers } = await signedWrikeBody([{ eventType: "X" }]);
    const result = await processInboundWebhook({
      destination,
      vendorAddon: wrikeAddon,
      destinationAddon: null,
      headers,
      rawBody,
      method: "POST",
      receivedAt: 55,
    });

    expect(result.ok).toBe(true);
    expect(persistedPayload(result)).toEqual({
      source: "wrike",
      receivedAt: 55,
      events: [{ eventType: "X" }],
    });
  });

  test("rejects an invalid signature before parsing the body", async () => {
    const result = await processInboundWebhook({
      destination,
      vendorAddon: wrikeAddon,
      destinationAddon: null,
      headers: { "x-hook-signature": "wrong" },
      rawBody: "this is not json either",
      method: "POST",
      receivedAt: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error.kind).toBe(AppErrorKind.Unauthorized);
    }
  });

  test("rejects a body that is not JSON", async () => {
    const rawBody = "not json";
    const result = await processInboundWebhook({
      destination,
      vendorAddon: wrikeAddon,
      destinationAddon: null,
      headers: { "x-hook-signature": await hmacSha256Hex("shhh", rawBody) },
      rawBody,
      method: "POST",
      receivedAt: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error.kind).toBe(AppErrorKind.BadRequest);
    }
  });

  test("rejects a payload that violates the vendor accepts schema", async () => {
    const { rawBody, headers } = await signedWrikeBody("a string payload");
    const result = await processInboundWebhook({
      destination,
      vendorAddon: wrikeAddon,
      destinationAddon: null,
      headers,
      rawBody,
      method: "POST",
      receivedAt: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error.kind).toBe(AppErrorKind.UnprocessableEntity);
    }
  });

  test("runs the destination addon on the vendor addon output", async () => {
    const { rawBody, headers } = await signedWrikeBody({ eventType: "X" });
    const result = await processInboundWebhook({
      destination,
      vendorAddon: wrikeAddon,
      destinationAddon: envelopeAddon,
      headers,
      rawBody,
      method: "POST",
      receivedAt: 9,
    });

    expect(result.ok).toBe(true);
    expect(persistedPayload(result)).toEqual({
      label: "team",
      receivedAt: 9,
      data: {
        source: "wrike",
        receivedAt: 9,
        events: [{ eventType: "X" }],
      },
    });
  });

  test("an addon-supplied handshake response short-circuits the pipeline", async () => {
    const rawBody = JSON.stringify({
      requestType: "WebHook secret verification",
    });
    const result = await processInboundWebhook({
      destination,
      vendorAddon: wrikeAddon,
      destinationAddon: envelopeAddon,
      headers: {
        "x-hook-signature": await hmacSha256Hex("shhh", rawBody),
        "x-hook-secret": "challenge-value",
      },
      rawBody,
      method: "POST",
      receivedAt: 3,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe(InboundOutcomeKind.Respond);
      if (result.value.kind === InboundOutcomeKind.Respond) {
        expect(result.value.response.headers["x-hook-secret"]).toBe(
          await hmacSha256Hex("shhh", "challenge-value"),
        );
      }
    }
  });

  test("a destination addon can answer the request itself", async () => {
    const responder: LoadedAddon = {
      manifest: manifest({ name: "responder" }),
      source: AddonSource.Builtin,
      module: {
        authenticate() {
          return {
            ok: true,
            respondWith: { status: 204, headers: {}, body: null },
          };
        },
      },
    };

    const result = await processInboundWebhook({
      destination,
      vendorAddon: passthroughAddon,
      destinationAddon: responder,
      headers: {},
      rawBody: "{}",
      method: "POST",
      receivedAt: 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === InboundOutcomeKind.Respond) {
      expect(result.value.response.status).toBe(204);
    }
  });

  test("runs the vendor stage strictly before the destination stage", async () => {
    const order: string[] = [];
    const vendor: LoadedAddon = {
      manifest: manifest({ name: "vendor-probe" }),
      source: AddonSource.Builtin,
      module: {
        authenticate() {
          order.push("vendor:auth");
          return { ok: true };
        },
        transform(input: JsonValue): JsonValue {
          order.push("vendor:transform");
          return input;
        },
      },
    };
    const destinationAddon: LoadedAddon = {
      manifest: manifest({ name: "destination-probe" }),
      source: AddonSource.Builtin,
      module: {
        authenticate() {
          order.push("destination:auth");
          return { ok: true };
        },
        transform(input: JsonValue): JsonValue {
          order.push("destination:transform");
          return input;
        },
      },
    };

    const result = await processInboundWebhook({
      destination,
      vendorAddon: vendor,
      destinationAddon,
      headers: {},
      rawBody: "{}",
      method: "POST",
      receivedAt: 1,
    });

    expect(result.ok).toBe(true);
    expect(order).toEqual([
      "vendor:auth",
      "vendor:transform",
      "destination:auth",
      "destination:transform",
    ]);
  });

  test("a failing destination authentication stops the pipeline", async () => {
    const destinationAddon: LoadedAddon = {
      manifest: manifest({ name: "denier" }),
      source: AddonSource.Builtin,
      module: {
        authenticate() {
          return { ok: false, status: 403, message: "denied" };
        },
      },
    };

    const result = await processInboundWebhook({
      destination,
      vendorAddon: passthroughAddon,
      destinationAddon,
      headers: {},
      rawBody: "{}",
      method: "POST",
      receivedAt: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error.kind).toBe(AppErrorKind.Forbidden);
    }
  });

  test("a transform that throws is reported as a generic internal error", async () => {
    // The inbound endpoint is public, so the exception text stays server-side:
    // the sender only receives a reference it can quote.
    const vendor: LoadedAddon = {
      manifest: manifest({ name: "thrower" }),
      source: AddonSource.Builtin,
      module: {
        transform(): JsonValue {
          throw new Error("boom: /srv/secret/path");
        },
      },
    };

    const result = await processInboundWebhook({
      destination,
      vendorAddon: vendor,
      destinationAddon: null,
      headers: {},
      rawBody: "{}",
      method: "POST",
      receivedAt: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error.kind).toBe(AppErrorKind.Internal);
      expect(result.error.message).not.toContain("boom");
      expect(result.error.message).not.toContain("thrower");
      expect(result.error.message).toContain("reference");
    }
  });

  test("an addon authentication that throws is reported generically", async () => {
    const vendor: LoadedAddon = {
      manifest: manifest({ name: "auth-thrower" }),
      source: AddonSource.Builtin,
      module: {
        authenticate(): never {
          throw new Error("upstream token 12345 rejected");
        },
      },
    };

    const result = await processInboundWebhook({
      destination,
      vendorAddon: vendor,
      destinationAddon: null,
      headers: {},
      rawBody: "{}",
      method: "POST",
      receivedAt: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error.kind).toBe(AppErrorKind.Internal);
      expect(result.error.message).not.toContain("12345");
      expect(result.error.message).toContain("reference");
    }
  });

  test("keeps the schema detail on an input mismatch", async () => {
    // The 422 is the sender's to fix, so it must say what the schema rejected.
    const { rawBody, headers } = await signedWrikeBody("a string payload");
    const result = await processInboundWebhook({
      destination,
      vendorAddon: wrikeAddon,
      destinationAddon: null,
      headers,
      rawBody,
      method: "POST",
      receivedAt: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error.kind).toBe(AppErrorKind.UnprocessableEntity);
      expect(result.error.message).toContain("does not match its schema");
    }
  });

  test("an output that violates the returns schema is an internal error", async () => {
    const vendor: LoadedAddon = {
      manifest: manifest({
        name: "bad-output",
        returnsSchema: { type: "object", required: ["expected"] },
      }),
      source: AddonSource.Builtin,
      module: {
        transform(): JsonValue {
          return { unexpected: true };
        },
      },
    };

    const result = await processInboundWebhook({
      destination,
      vendorAddon: vendor,
      destinationAddon: null,
      headers: {},
      rawBody: "{}",
      method: "POST",
      receivedAt: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error.kind).toBe(AppErrorKind.Internal);
      // A server-side defect: the schema detail is logged, not returned.
      expect(result.error.message).not.toContain("schema");
      expect(result.error.message).toContain("reference");
    }
  });
});
