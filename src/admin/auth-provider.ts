/**
 * External identity provider abstraction for the admin surface.
 *
 * web-hooky never implements end-user authentication. It consumes an identity
 * asserted by an upstream IdP proxy (Cloudflare Access, Vercel, GCP IAP, ...).
 */
import { AdminAuthMode, type AppConfig } from "../config";
import { timingSafeEqualString } from "../core/ids";

export interface AdminIdentity {
  readonly subject: string;
  readonly provider: string;
}

export interface AdminAuthProvider {
  readonly name: string;
  /** Returns the asserted identity, or null when none is present/valid. */
  authenticate(request: Request): Promise<AdminIdentity | null>;
}

/**
 * Reads the identity from a header injected by a trusted reverse proxy.
 *
 * The origin must not be reachable directly; when it can be, configure
 * `WEBHOOKY_ADMIN_AUTH_SHARED_SECRET` so a forged identity header is rejected.
 */
export function createTrustedHeaderProvider(
  config: AppConfig,
): AdminAuthProvider {
  return {
    name: AdminAuthMode.TrustedHeader,
    authenticate(request: Request): Promise<AdminIdentity | null> {
      if (config.adminAuthSharedSecret !== null) {
        const provided =
          request.headers.get(config.adminAuthSharedSecretHeader) ?? "";
        if (
          timingSafeEqualString(provided, config.adminAuthSharedSecret) ===
          false
        ) {
          return Promise.resolve(null);
        }
      }
      const subject = request.headers.get(config.adminAuthHeader);
      if (subject === null || subject.trim().length === 0) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        subject: subject.trim(),
        provider: AdminAuthMode.TrustedHeader,
      });
    },
  };
}

/** Development provider: every request is the configured local subject. */
export function createDevProvider(config: AppConfig): AdminAuthProvider {
  return {
    name: AdminAuthMode.Dev,
    authenticate(): Promise<AdminIdentity | null> {
      return Promise.resolve({
        subject: config.adminDevSubject,
        provider: AdminAuthMode.Dev,
      });
    },
  };
}

/** Rejects every IdP identity; only admin API keys can be used. */
export function createDisabledProvider(): AdminAuthProvider {
  return {
    name: AdminAuthMode.Disabled,
    authenticate(): Promise<AdminIdentity | null> {
      return Promise.resolve(null);
    },
  };
}

export function createAdminAuthProvider(config: AppConfig): AdminAuthProvider {
  switch (config.adminAuthMode) {
    case AdminAuthMode.TrustedHeader:
      return createTrustedHeaderProvider(config);
    case AdminAuthMode.Dev:
      return createDevProvider(config);
    case AdminAuthMode.Disabled:
      return createDisabledProvider();
    default: {
      const exhaustive: never = config.adminAuthMode;
      throw new Error(`Unhandled admin auth mode: ${String(exhaustive)}`);
    }
  }
}
