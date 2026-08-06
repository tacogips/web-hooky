/**
 * The `webhooky admin ...` command group.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { WebhookyAdminClient } from "../admin-client.js";
import type {
  CreateDestinationInput,
  CreateRelayInput,
  UpdateDestinationInput,
  UpdateRelayInput,
} from "../types.js";
import {
  buildAdminClient,
  emit,
  jsonFlag,
  numberFlag,
  type ParsedArgs,
  requirePositional,
  stringFlag,
  tristateFlag,
} from "./args.js";
import { UsageError } from "./env.js";

interface Context {
  readonly client: WebhookyAdminClient;
  readonly args: ParsedArgs;
  readonly pretty: boolean;
  /** Positionals after `admin <resource> <action>`. */
  readonly rest: readonly string[];
}

async function destinations(ctx: Context, action: string): Promise<void> {
  const { client, args, pretty, rest } = ctx;
  switch (action) {
    case "list":
      return emit(await client.listDestinations(), pretty);
    case "get":
      return emit(
        await client.getDestination(requirePositional(rest, 0, "id")),
        pretty,
      );
    case "delete": {
      const id = requirePositional(rest, 0, "id");
      await client.deleteDestination(id);
      return emit({ deleted: id }, pretty);
    }
    case "rotate-fetch-uuid":
      return emit(
        await client.rotateFetchUuid(requirePositional(rest, 0, "id")),
        pretty,
      );
    case "records":
      return emit(
        await client.listDestinationRecords(
          requirePositional(rest, 0, "id"),
          numberFlag(args, "limit"),
        ),
        pretty,
      );
    case "create": {
      const name = stringFlag(args, "name");
      const vendorAddon = stringFlag(args, "vendor-addon");
      if (name === undefined || vendorAddon === undefined) {
        throw new UsageError("--name and --vendor-addon are required");
      }
      const input: CreateDestinationInput = {
        name,
        vendorAddon,
        ...optional("destinationAddon", stringFlag(args, "destination-addon")),
        ...optional("vendorConfig", await jsonFlag(args, "vendor-config")),
        ...optional(
          "destinationConfig",
          await jsonFlag(args, "destination-config"),
        ),
        ...optional("retentionSeconds", numberFlag(args, "retention-seconds")),
      };
      return emit(await client.createDestination(input), pretty);
    }
    case "patch": {
      const id = requirePositional(rest, 0, "id");
      const input: UpdateDestinationInput = {
        ...optional("name", stringFlag(args, "name")),
        ...optional("enabled", tristateFlag(args, "enabled")),
        ...optional("destinationAddon", stringFlag(args, "destination-addon")),
        ...optional("vendorConfig", await jsonFlag(args, "vendor-config")),
        ...optional(
          "destinationConfig",
          await jsonFlag(args, "destination-config"),
        ),
        ...optional("retentionSeconds", numberFlag(args, "retention-seconds")),
      };
      return emit(await client.updateDestination(id, input), pretty);
    }
    default:
      throw new UsageError(
        "expected: list | get | create | patch | delete | rotate-fetch-uuid | records",
      );
  }
}

/** Includes a key only when the flag was supplied. */
function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : ({ [key]: value } as Record<string, T>);
}

async function relays(ctx: Context, action: string): Promise<void> {
  const { client, args, pretty, rest } = ctx;
  switch (action) {
    case "list":
      return emit(
        await client.listRelays(stringFlag(args, "destination-id")),
        pretty,
      );
    case "get":
      return emit(
        await client.getRelay(requirePositional(rest, 0, "id")),
        pretty,
      );
    case "delete": {
      const id = requirePositional(rest, 0, "id");
      await client.deleteRelay(id);
      return emit({ deleted: id }, pretty);
    }
    case "deliveries":
      return emit(
        await client.listRelayDeliveries(
          requirePositional(rest, 0, "id"),
          numberFlag(args, "limit"),
        ),
        pretty,
      );
    case "retry":
      return emit(
        { requeued: await client.retryRelay(requirePositional(rest, 0, "id")) },
        pretty,
      );
    case "create": {
      const destinationId = stringFlag(args, "destination-id");
      const name = stringFlag(args, "name");
      const targetUrl = stringFlag(args, "target-url");
      if (
        destinationId === undefined ||
        name === undefined ||
        targetUrl === undefined
      ) {
        throw new UsageError(
          "--destination-id, --name and --target-url are required",
        );
      }
      const input: CreateRelayInput = {
        destinationId,
        name,
        targetUrl,
        ...optional("secret", stringFlag(args, "secret")),
        ...optional("enabled", tristateFlag(args, "enabled")),
        ...optional("maxAttempts", numberFlag(args, "max-attempts")),
        ...optional("backoffSeconds", numberFlag(args, "backoff-seconds")),
        ...optional("timeoutSeconds", numberFlag(args, "timeout-seconds")),
      };
      return emit(await client.createRelay(input), pretty);
    }
    case "patch": {
      const id = requirePositional(rest, 0, "id");
      const input: UpdateRelayInput = {
        ...optional("name", stringFlag(args, "name")),
        ...optional("targetUrl", stringFlag(args, "target-url")),
        ...optional("secret", stringFlag(args, "secret")),
        ...optional("enabled", tristateFlag(args, "enabled")),
        ...optional("maxAttempts", numberFlag(args, "max-attempts")),
        ...optional("backoffSeconds", numberFlag(args, "backoff-seconds")),
        ...optional("timeoutSeconds", numberFlag(args, "timeout-seconds")),
      };
      return emit(await client.updateRelay(id, input), pretty);
    }
    default:
      throw new UsageError(
        "expected: list | get | create | patch | delete | deliveries | retry",
      );
  }
}

async function users(ctx: Context, action: string): Promise<void> {
  const { client, args, pretty, rest } = ctx;
  switch (action) {
    case "list":
      return emit(await client.listApiUsers(), pretty);
    case "get":
      return emit(
        await client.getApiUser(requirePositional(rest, 0, "id")),
        pretty,
      );
    case "create": {
      const label = stringFlag(args, "label");
      if (label === undefined) {
        throw new UsageError("--label is required");
      }
      // The secret appears here and nowhere else, ever.
      return emit(await client.createApiUser(label), pretty);
    }
    case "rotate":
      return emit(
        await client.rotateApiUserSecret(requirePositional(rest, 0, "id")),
        pretty,
      );
    case "enable":
    case "disable":
      return emit(
        await client.setApiUserEnabled(
          requirePositional(rest, 0, "id"),
          action === "enable",
        ),
        pretty,
      );
    case "delete": {
      const id = requirePositional(rest, 0, "id");
      await client.deleteApiUser(id);
      return emit({ deleted: id }, pretty);
    }
    case "grant":
      return emit(
        await client.grantDestination(
          requirePositional(rest, 0, "userId"),
          requirePositional(rest, 1, "destinationId"),
        ),
        pretty,
      );
    case "revoke":
      return emit(
        await client.revokeDestination(
          requirePositional(rest, 0, "userId"),
          requirePositional(rest, 1, "destinationId"),
        ),
        pretty,
      );
    default:
      throw new UsageError(
        "expected: list | get | create | rotate | enable | disable | delete | grant | revoke",
      );
  }
}

async function addons(ctx: Context, action: string): Promise<void> {
  const { client, pretty, rest } = ctx;
  switch (action) {
    case "list":
      return emit(await client.listAddons(), pretty);
    case "get":
      return emit(
        await client.getAddon(requirePositional(rest, 0, "name")),
        pretty,
      );
    case "upload": {
      const path = requirePositional(rest, 0, "package.zip");
      let archive: Buffer;
      try {
        archive = await readFile(path);
      } catch (error) {
        throw new UsageError(
          `failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return emit(
        await client.uploadAddon(basename(path), new Uint8Array(archive)),
        pretty,
      );
    }
    case "delete": {
      const name = requirePositional(rest, 0, "name");
      await client.deleteAddon(name);
      return emit({ deleted: name }, pretty);
    }
    default:
      throw new UsageError("expected: list | get | upload | delete");
  }
}

async function keys(ctx: Context, action: string): Promise<void> {
  const { client, args, pretty, rest } = ctx;
  switch (action) {
    case "list":
      return emit(await client.listAdminKeys(), pretty);
    case "create": {
      const label = stringFlag(args, "label");
      if (label === undefined) {
        throw new UsageError("--label is required");
      }
      return emit(await client.createAdminKey(label), pretty);
    }
    case "delete": {
      const id = requirePositional(rest, 0, "id");
      await client.deleteAdminKey(id);
      return emit({ deleted: id }, pretty);
    }
    default:
      throw new UsageError("expected: list | create | delete");
  }
}

async function adminUsers(ctx: Context, action: string): Promise<void> {
  const { client, pretty, rest } = ctx;
  switch (action) {
    case "list":
      return emit(await client.listAdminUsers(), pretty);
    case "create":
      return emit(
        await client.createAdminUser(requirePositional(rest, 0, "subject")),
        pretty,
      );
    case "delete": {
      const subject = requirePositional(rest, 0, "subject");
      await client.deleteAdminUser(subject);
      return emit({ deleted: subject }, pretty);
    }
    default:
      throw new UsageError("expected: list | create | delete");
  }
}

const RESOURCES: Readonly<
  Record<string, (ctx: Context, action: string) => Promise<void>>
> = {
  destinations,
  relays,
  users,
  addons,
  keys,
  "admin-users": adminUsers,
};

export async function runAdmin(
  positionals: readonly string[],
  args: ParsedArgs,
  pretty: boolean,
): Promise<void> {
  const resource = positionals[0];
  if (resource === undefined) {
    throw new UsageError(
      "expected an admin resource: me, destinations, relays, users, addons, " +
        "keys, admin-users",
    );
  }

  const client = buildAdminClient(args);
  if (resource === "me") {
    return emit(await client.me(), pretty);
  }

  const handler = RESOURCES[resource];
  if (handler === undefined) {
    throw new UsageError(`unknown admin resource "${resource}"`);
  }
  const action = positionals[1];
  if (action === undefined) {
    throw new UsageError(`expected an action for "admin ${resource}"`);
  }
  return handler({ client, args, pretty, rest: positionals.slice(2) }, action);
}
