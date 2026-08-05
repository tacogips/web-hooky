/**
 * Typed client for `/_admin/api`.
 *
 * The admin UI has no privileged path of its own: every capability it offers is
 * one call against the same API an admin API key can use.
 */

export interface AdminDestination {
  readonly id: string;
  readonly name: string;
  readonly vendorAddon: string;
  readonly destinationAddon: string | null;
  readonly inboundUuid: string;
  readonly inboundPath: string;
  readonly fetchUuid: string;
  readonly fetchPath: string;
  readonly streamPath: string;
  readonly retentionSeconds: number | null;
  readonly enabled: boolean;
  readonly createdAt: number;
}

export interface AdminApiUser {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly grants: readonly string[];
}

export interface CreatedApiUser extends AdminApiUser {
  readonly secret: string;
  readonly credential: string;
}

export interface AdminRelayStats {
  readonly pending: number;
  readonly delivered: number;
  readonly failed: number;
}

export interface AdminRelay {
  readonly id: string;
  readonly destinationId: string;
  readonly name: string;
  readonly targetUrl: string;
  readonly hasSecret: boolean;
  readonly enabled: boolean;
  readonly maxAttempts: number;
  readonly backoffSeconds: number;
  readonly timeoutSeconds: number;
  readonly createdAt: number;
  readonly deliveryStats?: AdminRelayStats;
}

export interface CreateRelayInput {
  readonly destinationId: string;
  readonly name: string;
  readonly targetUrl: string;
  readonly secret: string | null;
  readonly maxAttempts: number | null;
}

export interface AdminAddon {
  readonly name: string;
  readonly version: string;
  readonly kind: string;
  readonly description: string;
  readonly source: string;
  readonly hasAuthenticate: boolean;
  readonly hasTransform: boolean;
}

export interface AdminKeySummary {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly createdAt: number;
}

export interface CreatedAdminKey extends AdminKeySummary {
  readonly secret: string;
  readonly credential: string;
}

export interface AdminUser {
  readonly subject: string;
  readonly role: string;
  readonly createdAt: number;
}

export interface AdminIdentityInfo {
  readonly subject: string;
  readonly viaApiKey: boolean;
  readonly adminAuthProvider: string;
}

export interface CreateDestinationInput {
  readonly name: string;
  readonly vendorAddon: string;
  readonly destinationAddon: string | null;
  readonly vendorConfig: Record<string, unknown>;
  readonly destinationConfig: Record<string, unknown>;
  readonly retentionSeconds: number | null;
}

const BASE = "/_admin/api";

/**
 * Credential used for API-key driven sessions; empty when relying on the IdP.
 *
 * Memory only: an admin credential grants unrestricted admin access and bypasses
 * CSRF checks, so it is never written to `localStorage`/`sessionStorage` where
 * any script on the origin could read it. It lives for one page load.
 */
let apiKeyCredential = "";

export function setApiKeyCredential(credential: string): void {
  apiKeyCredential = credential.trim();
}

export function getApiKeyCredential(): string {
  return apiKeyCredential;
}

/** Drops the in-memory credential; subsequent calls rely on the IdP session. */
export function clearApiKeyCredential(): void {
  apiKeyCredential = "";
}

function buildHeaders(extra: Record<string, string> = {}): HeadersInit {
  const headers: Record<string, string> = { ...extra };
  if (apiKeyCredential.length > 0) {
    headers["authorization"] = `Bearer ${apiKeyCredential}`;
  }
  return headers;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: buildHeaders(
      (init.headers as Record<string, string> | undefined) ?? {},
    ),
  });
  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  const parsed: unknown = text.length === 0 ? {} : JSON.parse(text);
  if (response.ok === false) {
    const message =
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof (parsed as { error: { message?: unknown } }).error.message ===
        "string"
        ? (parsed as { error: { message: string } }).error.message
        : `Request failed with status ${response.status}`;
    throw new Error(message);
  }
  return parsed as T;
}

function jsonRequest<T>(
  path: string,
  method: string,
  body: unknown,
): Promise<T> {
  return request<T>(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const adminApi = {
  me(): Promise<AdminIdentityInfo> {
    return request<AdminIdentityInfo>("/me");
  },

  async listDestinations(): Promise<readonly AdminDestination[]> {
    const result = await request<{ destinations: AdminDestination[] }>(
      "/destinations",
    );
    return result.destinations;
  },

  createDestination(input: CreateDestinationInput): Promise<AdminDestination> {
    return jsonRequest<AdminDestination>("/destinations", "POST", input);
  },

  deleteDestination(id: string): Promise<void> {
    return request<void>(`/destinations/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  rotateFetchUuid(id: string): Promise<AdminDestination> {
    return request<AdminDestination>(
      `/destinations/${encodeURIComponent(id)}/rotate-fetch-uuid`,
      { method: "POST" },
    );
  },

  async listRelays(): Promise<readonly AdminRelay[]> {
    const result = await request<{ relays: AdminRelay[] }>("/relays");
    return result.relays;
  },

  createRelay(input: CreateRelayInput): Promise<AdminRelay> {
    return jsonRequest<AdminRelay>("/relays", "POST", input);
  },

  setRelayEnabled(id: string, enabled: boolean): Promise<AdminRelay> {
    return jsonRequest<AdminRelay>(
      `/relays/${encodeURIComponent(id)}`,
      "PATCH",
      { enabled },
    );
  },

  retryRelay(id: string): Promise<{ requeued: number }> {
    return request<{ requeued: number }>(
      `/relays/${encodeURIComponent(id)}/retry`,
      { method: "POST" },
    );
  },

  deleteRelay(id: string): Promise<void> {
    return request<void>(`/relays/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  async listUsers(): Promise<readonly AdminApiUser[]> {
    const result = await request<{ users: AdminApiUser[] }>("/users");
    return result.users;
  },

  createUser(label: string): Promise<CreatedApiUser> {
    return jsonRequest<CreatedApiUser>("/users", "POST", { label });
  },

  rotateUserSecret(id: string): Promise<CreatedApiUser> {
    return request<CreatedApiUser>(`/users/${encodeURIComponent(id)}/rotate`, {
      method: "POST",
    });
  },

  deleteUser(id: string): Promise<void> {
    return request<void>(`/users/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  setGrant(
    userId: string,
    destinationId: string,
    granted: boolean,
  ): Promise<AdminApiUser> {
    return request<AdminApiUser>(
      `/users/${encodeURIComponent(userId)}/grants/${encodeURIComponent(destinationId)}`,
      { method: granted ? "PUT" : "DELETE" },
    );
  },

  async listAddons(): Promise<readonly AdminAddon[]> {
    const result = await request<{ addons: AdminAddon[] }>("/addons");
    return result.addons;
  },

  uploadAddon(file: File): Promise<AdminAddon> {
    const form = new FormData();
    form.append("package", file);
    return request<AdminAddon>("/addons", { method: "POST", body: form });
  },

  deleteAddon(name: string): Promise<void> {
    return request<void>(`/addons/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  },

  async listAdminKeys(): Promise<readonly AdminKeySummary[]> {
    const result = await request<{ keys: AdminKeySummary[] }>("/admin-keys");
    return result.keys;
  },

  createAdminKey(label: string): Promise<CreatedAdminKey> {
    return jsonRequest<CreatedAdminKey>("/admin-keys", "POST", { label });
  },

  deleteAdminKey(id: string): Promise<void> {
    return request<void>(`/admin-keys/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  async listAdminUsers(): Promise<readonly AdminUser[]> {
    const result = await request<{ adminUsers: AdminUser[] }>("/admin-users");
    return result.adminUsers;
  },

  createAdminUser(subject: string): Promise<AdminUser> {
    return jsonRequest<AdminUser>("/admin-users", "POST", { subject });
  },

  deleteAdminUser(subject: string): Promise<void> {
    return request<void>(`/admin-users/${encodeURIComponent(subject)}`, {
      method: "DELETE",
    });
  },
} as const;
