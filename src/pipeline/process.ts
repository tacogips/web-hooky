/**
 * Inbound webhook processing pipeline.
 *
 * Fixed ordering, as required by the specification:
 *   vendor authenticate -> vendor validate -> vendor transform
 *   -> destination authenticate -> destination validate -> destination transform
 *
 * Nothing is persisted until the whole pipeline succeeds.
 */
import { AppErrorKind, type AppError, appError, errors } from "../core/errors";
import { newUuid } from "../core/ids";
import { type JsonValue, parseJsonText } from "../core/json";
import { err, getErrorMessage, ok, type Result } from "../core/result";
import { formatSchemaIssues, validateJsonSchema } from "../schema/validate";
import type { DestinationRecord } from "../storage/types";
import type {
  AddonAuthResult,
  AddonRequestContext,
  AddonResponse,
  AddonTransformContext,
  LoadedAddon,
} from "../addons/types";

export enum AddonStage {
  Vendor = "vendor",
  Destination = "destination",
}

export enum InboundOutcomeKind {
  /** The payload is ready to be stored and fanned out. */
  Persist = "persist",
  /** An addon answered the request itself; nothing is stored. */
  Respond = "respond",
}

export type InboundOutcome =
  | { readonly kind: InboundOutcomeKind.Persist; readonly payload: JsonValue }
  | {
      readonly kind: InboundOutcomeKind.Respond;
      readonly response: AddonResponse;
    };

export interface ProcessInboundInput {
  readonly destination: DestinationRecord;
  readonly vendorAddon: LoadedAddon;
  readonly destinationAddon: LoadedAddon | null;
  /** Lower-cased request headers. */
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: string;
  readonly method: string;
  readonly receivedAt: number;
}

/**
 * Reports an addon-side failure without handing its detail to the sender.
 *
 * The inbound endpoint is public, and an exception thrown by addon code can
 * carry file paths, upstream error text or configuration values. The full
 * message is logged under a reference; the caller only receives the reference.
 */
function internalAddonError(detail: string): AppError {
  const reference = newUuid();
  console.error(`[web-hooky] internal error ${reference}: ${detail}`);
  return errors.internal(`Addon processing failed (reference ${reference})`);
}

function statusToErrorKind(status: number): AppErrorKind {
  if (status === 403) {
    return AppErrorKind.Forbidden;
  }
  if (status >= 500) {
    return AppErrorKind.Internal;
  }
  if (status === 400) {
    return AppErrorKind.BadRequest;
  }
  return AppErrorKind.Unauthorized;
}

/**
 * Runs an addon's authentication hook.
 *
 * A successful result carries the response the addon wants sent instead of the
 * normal pipeline output, or null when processing should continue.
 */
async function runAuthenticate(
  addon: LoadedAddon,
  stage: AddonStage,
  ctx: AddonRequestContext,
): Promise<Result<AddonResponse | null, AppError>> {
  if (addon.module.authenticate === undefined) {
    return ok(null);
  }
  let result: AddonAuthResult;
  try {
    result = await addon.module.authenticate(ctx);
  } catch (error) {
    return err(
      internalAddonError(
        `${stage} addon "${addon.manifest.name}" authentication failed: ${getErrorMessage(error)}`,
      ),
    );
  }
  if (result.ok) {
    return ok(result.respondWith ?? null);
  }
  return err(appError(statusToErrorKind(result.status), result.message));
}

function validateStage(
  addon: LoadedAddon,
  stage: AddonStage,
  direction: "input" | "output",
  value: JsonValue,
): Result<JsonValue, AppError> {
  const schema =
    direction === "input"
      ? addon.manifest.acceptsSchema
      : addon.manifest.returnsSchema;
  const validation = validateJsonSchema(schema, value);
  if (validation.ok) {
    return ok(validation.value);
  }
  const message = `${stage} addon "${addon.manifest.name}" ${direction} does not match its schema: ${formatSchemaIssues(validation.error)}`;
  // An input mismatch is the sender's problem and the detail helps them fix
  // the payload; an output mismatch is a server-side defect, so it is logged
  // rather than returned.
  return err(
    direction === "input"
      ? errors.unprocessable(message)
      : internalAddonError(message),
  );
}

async function runTransform(
  addon: LoadedAddon,
  stage: AddonStage,
  value: JsonValue,
  ctx: AddonTransformContext,
): Promise<Result<JsonValue, AppError>> {
  if (addon.module.transform === undefined) {
    return ok(value);
  }
  try {
    return ok(await addon.module.transform(value, ctx));
  } catch (error) {
    return err(
      internalAddonError(
        `${stage} addon "${addon.manifest.name}" transform failed: ${getErrorMessage(error)}`,
      ),
    );
  }
}

async function runStage(
  addon: LoadedAddon,
  stage: AddonStage,
  value: JsonValue,
  requestCtx: AddonRequestContext,
): Promise<Result<InboundOutcome, AppError>> {
  const authenticated = await runAuthenticate(addon, stage, requestCtx);
  if (authenticated.ok === false) {
    return err(authenticated.error);
  }
  if (authenticated.value !== null) {
    return ok({
      kind: InboundOutcomeKind.Respond,
      response: authenticated.value,
    });
  }

  const accepted = validateStage(addon, stage, "input", value);
  if (accepted.ok === false) {
    return err(accepted.error);
  }

  const transformCtx: AddonTransformContext = {
    headers: requestCtx.headers,
    config: requestCtx.config,
    destinationId: requestCtx.destinationId,
    addonName: requestCtx.addonName,
    receivedAt: requestCtx.receivedAt,
  };
  const transformed = await runTransform(
    addon,
    stage,
    accepted.value,
    transformCtx,
  );
  if (transformed.ok === false) {
    return err(transformed.error);
  }

  const output = validateStage(addon, stage, "output", transformed.value);
  if (output.ok === false) {
    return err(output.error);
  }
  return ok({ kind: InboundOutcomeKind.Persist, payload: output.value });
}

/**
 * Runs the vendor stage and then the destination stage over a raw request body.
 */
export async function processInboundWebhook(
  input: ProcessInboundInput,
): Promise<Result<InboundOutcome, AppError>> {
  const vendorCtx: AddonRequestContext = {
    method: input.method,
    headers: input.headers,
    rawBody: input.rawBody,
    config: input.destination.vendorConfig,
    destinationId: input.destination.id,
    addonName: input.vendorAddon.manifest.name,
    receivedAt: input.receivedAt,
  };

  // Authentication runs before the body is even parsed so that an unsigned
  // request never reaches parsing or validation code.
  const vendorAuth = await runAuthenticate(
    input.vendorAddon,
    AddonStage.Vendor,
    vendorCtx,
  );
  if (vendorAuth.ok === false) {
    return err(vendorAuth.error);
  }
  // A vendor handshake (Wrike's secure-webhook verification) is answered by the
  // addon and must not be parsed, validated or stored.
  if (vendorAuth.value !== null) {
    return ok({
      kind: InboundOutcomeKind.Respond,
      response: vendorAuth.value,
    });
  }

  const parsed = parseJsonText(input.rawBody);
  if (parsed.ok === false) {
    return err(
      errors.badRequest(`Request body is not valid JSON: ${parsed.error}`),
    );
  }

  const accepted = validateStage(
    input.vendorAddon,
    AddonStage.Vendor,
    "input",
    parsed.value,
  );
  if (accepted.ok === false) {
    return err(accepted.error);
  }

  const vendorTransformed = await runTransform(
    input.vendorAddon,
    AddonStage.Vendor,
    accepted.value,
    {
      headers: vendorCtx.headers,
      config: vendorCtx.config,
      destinationId: vendorCtx.destinationId,
      addonName: vendorCtx.addonName,
      receivedAt: vendorCtx.receivedAt,
    },
  );
  if (vendorTransformed.ok === false) {
    return err(vendorTransformed.error);
  }

  const vendorOutput = validateStage(
    input.vendorAddon,
    AddonStage.Vendor,
    "output",
    vendorTransformed.value,
  );
  if (vendorOutput.ok === false) {
    return err(vendorOutput.error);
  }

  if (input.destinationAddon === null) {
    return ok({
      kind: InboundOutcomeKind.Persist,
      payload: vendorOutput.value,
    });
  }

  const destinationCtx: AddonRequestContext = {
    method: input.method,
    headers: input.headers,
    rawBody: input.rawBody,
    config: input.destination.destinationConfig,
    destinationId: input.destination.id,
    addonName: input.destinationAddon.manifest.name,
    receivedAt: input.receivedAt,
  };

  return runStage(
    input.destinationAddon,
    AddonStage.Destination,
    vendorOutput.value,
    destinationCtx,
  );
}
