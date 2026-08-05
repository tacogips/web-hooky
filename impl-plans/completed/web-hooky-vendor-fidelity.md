# web-hooky Vendor Fidelity Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/architecture.md#2-addon-system, design-docs/specs/notes.md
**Created**: 2026-08-05
**Last Updated**: 2026-08-05

---

## Design Document Reference

**Source**: design-docs/specs/architecture.md (section 2), design-docs/specs/command.md,
design-docs/specs/notes.md

### Summary

Findings from the second independent implementation review: the built-in `wrike` addon
verified the HMAC against the wrong header and could not answer the secure-webhook
registration handshake, the inbound body cap was enforced only after buffering when no
`Content-Length` was present, a grant timestamp bypassed the injected clock, and the operator
documentation understated both the `trusted-header` spoofing risk and the `/_get` delivery
contract.

### Scope

**Included**: `src/addons/{types.ts,builtin/wrike.ts}`, `src/pipeline/process.ts`,
`src/server/webhook.ts`, `src/storage/{persistence.ts,sqlite/api-user-store.ts}`,
`src/admin/users-api.ts`, `src/config.ts`, `src/main.ts`, `README.md`,
`design-docs/specs/{architecture,command,notes}.md`
**Excluded**: the trust model of uploaded addon code (unchanged by design), relay semantics

---

## Modules

### 1. Addon response contract (F1)

#### src/addons/types.ts, src/pipeline/process.ts, src/server/webhook.ts

**Status**: COMPLETED

```typescript
interface AddonResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}
type AddonAuthResult =
  | { readonly ok: true; readonly respondWith?: AddonResponse }
  | { readonly ok: false; readonly status: number; readonly message: string };
function addonAuthHandled(response: AddonResponse): AddonAuthResult;

enum InboundOutcomeKind { Persist = "persist", Respond = "respond" }
type InboundOutcome =
  | { readonly kind: InboundOutcomeKind.Persist; readonly payload: JsonValue }
  | { readonly kind: InboundOutcomeKind.Respond; readonly response: AddonResponse };
```

**Checklist**:
- [x] `authenticate` may answer the request instead of continuing the pipeline
- [x] Either stage (vendor, destination) can short-circuit
- [x] A short-circuited request is never parsed, validated, persisted, broadcast or relayed
- [x] The server rejects an addon status outside 200-599 and unusable headers as a 500

### 2. Wrike protocol fidelity (F1)

#### src/addons/builtin/wrike.ts

**Status**: COMPLETED

```typescript
const WRIKE_SIGNATURE_HEADER = "x-hook-signature";
const WRIKE_SECRET_HEADER = "x-hook-secret";
const WRIKE_VERIFICATION_REQUEST_TYPE = "WebHook secret verification";
```

**Checklist**:
- [x] Event deliveries verify `X-Hook-Signature` against the HMAC of the raw body
- [x] Hex and base64 renderings are both accepted (Wrike does not document the encoding),
      each compared in constant time
- [x] The `{"requestType":"WebHook secret verification"}` handshake is answered with
      `X-Hook-Secret: hmacSha256(secret, received X-Hook-Secret)` in the incoming encoding
- [x] A handshake without a signature, or without a challenge value, is rejected
- [x] Negative test: the body HMAC presented only in `X-Hook-Secret` does not authenticate

### 3. Inbound body cap (F3)

#### src/server/webhook.ts

**Status**: COMPLETED

**Checklist**:
- [x] Requests without `Content-Length` are read incrementally from `request.body`
- [x] The reader is cancelled as soon as the accumulated bytes pass the cap
- [x] Regression test asserts the remaining chunks are never pulled

### 4. Grant timestamp and operator documentation (F2, F4, F5)

#### src/storage/persistence.ts, src/storage/sqlite/api-user-store.ts, src/admin/users-api.ts, src/config.ts, src/main.ts

**Status**: COMPLETED

```typescript
grant(userId: string, destinationId: string, createdAt: number): Promise<void>;
function configWarnings(config: AppConfig): readonly string[];
```

**Checklist**:
- [x] `grant()` takes the timestamp from the caller's clock, like every other store write
- [x] `trusted-header` risk documented in `README.md` and `command.md`
- [x] Startup warning when bound to a non-loopback address without a proxy shared secret
- [x] `notes.md` states the `/_get` contract as at-most-once for `only_unfetched` consumers
- [x] `notes.md` documents how the body cap is enforced

### 5. Handshake challenge validation (R1)

#### src/addons/builtin/wrike.ts

**Status**: COMPLETED

```typescript
const WRIKE_MAX_CHALLENGE_LENGTH = 100;
const WRIKE_CHALLENGE_PATTERN = /^[A-Za-z0-9._-]+$/;
```

**Checklist**:
- [x] The handshake challenge is validated before any HMAC over it is computed
- [x] A challenge over 100 characters is rejected with 400
- [x] A challenge containing characters outside the allowlist (JSON syntax, whitespace) is
      rejected with 400
- [x] A genuine alphanumeric challenge, including one of exactly 100 characters, still succeeds
- [x] End-to-end regression test: a replayed handshake carrying a forged event body as the
      challenge returns 400 with no `x-hook-secret` header and leaks no signature, and the
      forged delivery remains 401 with nothing stored
- [x] The signing-oracle hazard and the guard are documented in the addon docstring,
      `README.md` and `architecture.md`, including the general rule for `respondWith` addons

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| Wrike fidelity | Addon response contract | Available |
| Challenge validation | Wrike fidelity | Available |
| Body cap | Server core | Available |
| Grant clock | Storage adapters | Available |

## Completion Criteria

- [x] All modules implemented
- [x] All tests passing (`bun test`)
- [x] Type checking passes (`tsc --noEmit`)
- [x] Biome reports no errors

## Progress Log

### Session: 2026-08-05

**Tasks Completed**: TASK-001, TASK-002, TASK-003, TASK-004
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Wrike's published documentation states the signature algorithm but not its
encoding, so the addon accepts both the hex and the base64 rendering rather than guessing;
the handshake reply mirrors whichever encoding the request used. Adding `respondWith` to
`AddonAuthResult` changed the pipeline return type to a tagged `InboundOutcome`; the
alternative (documenting the handshake as unsupported) was rejected because a secure Wrike
webhook cannot be registered at all without it. The `grant()` signature now takes an explicit
`createdAt`, matching how every other store receives its timestamps.

### Session: 2026-08-05 (follow-up)

**Tasks Completed**: TASK-005
**Tasks In Progress**: None
**Blockers**: None
**Notes**: The third review found that the handshake reply added in TASK-002 signed the
received `X-Hook-Secret` unconditionally, which is a signing oracle: the handshake body is a
constant, so its signature never rotates and must be assumed observable, and replaying it with
a forged event body as the challenge returned a valid `X-Hook-Signature` for that body. The
fix is the length and character guard Wrike's documentation prescribes, applied before any
HMAC is computed. The allowlist is `[A-Za-z0-9._-]` rather than strictly alphanumeric: it
still excludes every character JSON needs, so no reply can be a usable body signature, while
tolerating token-shaped challenges. Rejecting with 400 rather than 401 keeps a malformed
handshake distinguishable from a signature failure.

## Related Plans

- **Previous**: `impl-plans/completed/web-hooky-hardening.md`
- **Related**: `impl-plans/completed/web-hooky-foundation.md`
