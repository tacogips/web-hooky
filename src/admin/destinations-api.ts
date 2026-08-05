/**
 * Admin API handlers for destinations and record inspection.
 */
import { errors } from "../core/errors";
import { newUuid } from "../core/ids";
import type { JsonObject } from "../core/json";
import { formatSchemaIssues, validateJsonSchema } from "../schema/validate";
import type { AppContext } from "../server/context";
import { invalidateDestination } from "../server/lookups";
import {
  errorResponse,
  jsonResponse,
  noContentResponse,
} from "../server/responses";
import type { DestinationRecord } from "../storage/types";
import type { AdminPrincipal } from "./auth";
import {
  destinationToJson,
  optionalBooleanField,
  optionalIntegerField,
  optionalObjectField,
  optionalStringField,
  publicRecordToJson,
  readJsonObjectBody,
  requireStringField,
} from "./helpers";

/** Validates a destination config object against an addon's config schema. */
function validateAddonConfig(
  ctx: AppContext,
  addonName: string,
  config: JsonObject,
  role: "vendor" | "destination",
): string | null {
  const addon = ctx.registry.get(addonName);
  if (addon === null) {
    return `Unknown ${role} addon "${addonName}"`;
  }
  const schema = addon.manifest.configSchema;
  if (schema === null) {
    return null;
  }
  const validation = validateJsonSchema(schema, config);
  if (validation.ok) {
    return null;
  }
  return `Invalid ${role} addon configuration: ${formatSchemaIssues(validation.error)}`;
}

async function createDestination(
  ctx: AppContext,
  request: Request,
  principal: AdminPrincipal,
): Promise<Response> {
  const body = await readJsonObjectBody(request);
  if (body.ok === false) {
    return errorResponse(body.error);
  }

  const name = requireStringField(body.value, "name");
  if (name.ok === false) {
    return errorResponse(name.error);
  }
  const vendorAddon = requireStringField(body.value, "vendorAddon");
  if (vendorAddon.ok === false) {
    return errorResponse(vendorAddon.error);
  }
  const destinationAddon = optionalStringField(body.value, "destinationAddon");
  if (destinationAddon.ok === false) {
    return errorResponse(destinationAddon.error);
  }
  const vendorConfig = optionalObjectField(body.value, "vendorConfig");
  if (vendorConfig.ok === false) {
    return errorResponse(vendorConfig.error);
  }
  const destinationConfig = optionalObjectField(
    body.value,
    "destinationConfig",
  );
  if (destinationConfig.ok === false) {
    return errorResponse(destinationConfig.error);
  }
  const retentionSeconds = optionalIntegerField(body.value, "retentionSeconds");
  if (retentionSeconds.ok === false) {
    return errorResponse(retentionSeconds.error);
  }

  const vendorResolved = ctx.registry.requireVendor(vendorAddon.value);
  if (vendorResolved.ok === false) {
    return errorResponse(vendorResolved.error);
  }
  const vendorConfigIssue = validateAddonConfig(
    ctx,
    vendorAddon.value,
    vendorConfig.value,
    "vendor",
  );
  if (vendorConfigIssue !== null) {
    return errorResponse(errors.badRequest(vendorConfigIssue));
  }

  if (destinationAddon.value !== null) {
    const resolved = ctx.registry.requireDestination(destinationAddon.value);
    if (resolved.ok === false) {
      return errorResponse(resolved.error);
    }
    const issue = validateAddonConfig(
      ctx,
      destinationAddon.value,
      destinationConfig.value,
      "destination",
    );
    if (issue !== null) {
      return errorResponse(errors.badRequest(issue));
    }
  }

  const destination: DestinationRecord = {
    id: newUuid(),
    name: name.value,
    vendorAddon: vendorAddon.value,
    destinationAddon: destinationAddon.value,
    inboundUuid: newUuid(),
    fetchUuid: newUuid(),
    vendorConfig: vendorConfig.value,
    destinationConfig: destinationConfig.value,
    retentionSeconds: retentionSeconds.value,
    enabled: true,
    createdAt: ctx.clock.nowSeconds(),
    createdBy: principal.subject,
  };
  await ctx.persistence.destinations.create(destination);
  return jsonResponse(destinationToJson(destination), 201);
}

async function patchDestination(
  ctx: AppContext,
  request: Request,
  existing: DestinationRecord,
): Promise<Response> {
  const body = await readJsonObjectBody(request);
  if (body.ok === false) {
    return errorResponse(body.error);
  }

  const name = optionalStringField(body.value, "name");
  if (name.ok === false) {
    return errorResponse(name.error);
  }
  const enabled = optionalBooleanField(body.value, "enabled");
  if (enabled.ok === false) {
    return errorResponse(enabled.error);
  }
  const retentionSeconds = optionalIntegerField(body.value, "retentionSeconds");
  if (retentionSeconds.ok === false) {
    return errorResponse(retentionSeconds.error);
  }
  const destinationAddonProvided = "destinationAddon" in body.value;
  const destinationAddon = optionalStringField(body.value, "destinationAddon");
  if (destinationAddon.ok === false) {
    return errorResponse(destinationAddon.error);
  }

  const nextDestinationAddon = destinationAddonProvided
    ? destinationAddon.value
    : existing.destinationAddon;

  const vendorConfigProvided = "vendorConfig" in body.value;
  const vendorConfig = optionalObjectField(body.value, "vendorConfig");
  if (vendorConfig.ok === false) {
    return errorResponse(vendorConfig.error);
  }
  const destinationConfigProvided = "destinationConfig" in body.value;
  const destinationConfig = optionalObjectField(
    body.value,
    "destinationConfig",
  );
  if (destinationConfig.ok === false) {
    return errorResponse(destinationConfig.error);
  }

  const nextVendorConfig = vendorConfigProvided
    ? vendorConfig.value
    : existing.vendorConfig;
  const nextDestinationConfig = destinationConfigProvided
    ? destinationConfig.value
    : existing.destinationConfig;

  const vendorIssue = validateAddonConfig(
    ctx,
    existing.vendorAddon,
    nextVendorConfig,
    "vendor",
  );
  if (vendorIssue !== null) {
    return errorResponse(errors.badRequest(vendorIssue));
  }

  if (nextDestinationAddon !== null) {
    const resolved = ctx.registry.requireDestination(nextDestinationAddon);
    if (resolved.ok === false) {
      return errorResponse(resolved.error);
    }
    const issue = validateAddonConfig(
      ctx,
      nextDestinationAddon,
      nextDestinationConfig,
      "destination",
    );
    if (issue !== null) {
      return errorResponse(errors.badRequest(issue));
    }
  }

  const updated: DestinationRecord = {
    ...existing,
    name: name.value ?? existing.name,
    destinationAddon: nextDestinationAddon,
    vendorConfig: nextVendorConfig,
    destinationConfig: nextDestinationConfig,
    retentionSeconds:
      "retentionSeconds" in body.value
        ? retentionSeconds.value
        : existing.retentionSeconds,
    enabled: enabled.value ?? existing.enabled,
  };
  await ctx.persistence.destinations.update(updated);
  await invalidateDestination(ctx, existing);
  return jsonResponse(destinationToJson(updated));
}

async function rotateFetchUuid(
  ctx: AppContext,
  existing: DestinationRecord,
): Promise<Response> {
  const updated: DestinationRecord = { ...existing, fetchUuid: newUuid() };
  await ctx.persistence.destinations.update(updated);
  await invalidateDestination(ctx, existing);
  return jsonResponse(destinationToJson(updated));
}

async function listRecords(
  ctx: AppContext,
  url: URL,
  destination: DestinationRecord,
): Promise<Response> {
  const rawLimit = url.searchParams.get("limit");
  const parsedLimit =
    rawLimit === null
      ? ctx.config.defaultFetchLimit
      : Number.parseInt(rawLimit, 10);
  if (Number.isFinite(parsedLimit) === false || parsedLimit < 1) {
    return errorResponse(
      errors.badRequest('Parameter "limit" must be a positive integer'),
    );
  }
  // Admin inspection never marks records fetched.
  const records = await ctx.persistence.records.query({
    destinationId: destination.id,
    onlyUnfetched: false,
    from: null,
    to: null,
    limit: Math.min(parsedLimit, ctx.config.maxFetchLimit),
  });
  return jsonResponse({
    records: records.map((record) =>
      publicRecordToJson({
        t: record.t,
        fetched: record.fetched,
        payload: record.payload,
      }),
    ),
  });
}

/** Routes `/_admin/api/destinations...` and `/_admin/api/records/:id`. */
export async function handleDestinationsApi(
  ctx: AppContext,
  request: Request,
  url: URL,
  segments: readonly string[],
  principal: AdminPrincipal,
): Promise<Response> {
  const [resource, id, action] = segments;

  if (resource === "records") {
    if (id === undefined) {
      return errorResponse(
        errors.notFound("Expected /records/{destinationId}"),
      );
    }
    const destination = await ctx.persistence.destinations.findById(id);
    if (destination === null) {
      return errorResponse(errors.notFound("Unknown destination"));
    }
    return listRecords(ctx, url, destination);
  }

  if (id === undefined) {
    if (request.method === "GET") {
      const destinations = await ctx.persistence.destinations.list();
      return jsonResponse({
        destinations: destinations.map(destinationToJson),
      });
    }
    if (request.method === "POST") {
      return createDestination(ctx, request, principal);
    }
    return errorResponse(
      errors.methodNotAllowed(`Method ${request.method} is not allowed here`),
    );
  }

  const destination = await ctx.persistence.destinations.findById(id);
  if (destination === null) {
    return errorResponse(errors.notFound("Unknown destination"));
  }

  if (action === "rotate-fetch-uuid") {
    if (request.method !== "POST") {
      return errorResponse(
        errors.methodNotAllowed(`Method ${request.method} is not allowed here`),
      );
    }
    return rotateFetchUuid(ctx, destination);
  }

  if (action !== undefined) {
    return errorResponse(errors.notFound("Unknown destination action"));
  }

  if (request.method === "GET") {
    return jsonResponse(destinationToJson(destination));
  }
  if (request.method === "PATCH") {
    return patchDestination(ctx, request, destination);
  }
  if (request.method === "DELETE") {
    await ctx.persistence.records.deleteForDestination(destination.id);
    await ctx.persistence.destinations.delete(destination.id);
    await invalidateDestination(ctx, destination);
    return noContentResponse();
  }
  return errorResponse(
    errors.methodNotAllowed(`Method ${request.method} is not allowed here`),
  );
}
