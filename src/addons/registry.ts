/**
 * Addon registry.
 *
 * Addon names are unique across the whole server, regardless of whether the
 * addon is built in or was installed from an uploaded package.
 */
import { type AppError, errors } from "../core/errors";
import { err, ok, type Result } from "../core/result";
import { AddonSource } from "../storage/types";
import { supportsDestinationRole, supportsVendorRole } from "./manifest";
import type { LoadedAddon } from "./types";

export interface AddonRegistry {
  register(addon: LoadedAddon): Result<LoadedAddon, AppError>;
  unregister(name: string): boolean;
  get(name: string): LoadedAddon | null;
  /** Resolves an addon that must be usable in the vendor role. */
  requireVendor(name: string): Result<LoadedAddon, AppError>;
  /** Resolves an addon that must be usable in the destination role. */
  requireDestination(name: string): Result<LoadedAddon, AppError>;
  list(): readonly LoadedAddon[];
  has(name: string): boolean;
}

export function createAddonRegistry(
  initial: readonly LoadedAddon[] = [],
): AddonRegistry {
  const addons = new Map<string, LoadedAddon>();

  const registry: AddonRegistry = {
    register(addon: LoadedAddon): Result<LoadedAddon, AppError> {
      const existing = addons.get(addon.manifest.name);
      if (existing !== undefined) {
        return err(
          errors.conflict(
            `Addon "${addon.manifest.name}" is already registered (${existing.source})`,
          ),
        );
      }
      addons.set(addon.manifest.name, addon);
      return ok(addon);
    },

    unregister(name: string): boolean {
      const existing = addons.get(name);
      if (existing === undefined || existing.source === AddonSource.Builtin) {
        return false;
      }
      return addons.delete(name);
    },

    get(name: string): LoadedAddon | null {
      return addons.get(name) ?? null;
    },

    requireVendor(name: string): Result<LoadedAddon, AppError> {
      const addon = addons.get(name);
      if (addon === undefined) {
        return err(errors.notFound(`Unknown addon "${name}"`));
      }
      if (supportsVendorRole(addon.manifest) === false) {
        return err(
          errors.badRequest(`Addon "${name}" cannot be used as a vendor addon`),
        );
      }
      return ok(addon);
    },

    requireDestination(name: string): Result<LoadedAddon, AppError> {
      const addon = addons.get(name);
      if (addon === undefined) {
        return err(errors.notFound(`Unknown addon "${name}"`));
      }
      if (supportsDestinationRole(addon.manifest) === false) {
        return err(
          errors.badRequest(
            `Addon "${name}" cannot be used as a destination addon`,
          ),
        );
      }
      return ok(addon);
    },

    list(): readonly LoadedAddon[] {
      return [...addons.values()].sort((left, right) =>
        left.manifest.name.localeCompare(right.manifest.name),
      );
    },

    has(name: string): boolean {
      return addons.has(name);
    },
  };

  for (const addon of initial) {
    const registered = registry.register(addon);
    if (registered.ok === false) {
      // The initial set is a static, compiled-in list, so a duplicate name is a
      // programming error rather than an operational one; dropping it silently
      // would leave the server running one of two addons chosen at random.
      throw new Error(registered.error.message);
    }
  }

  return registry;
}
