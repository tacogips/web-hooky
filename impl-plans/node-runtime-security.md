# Node runtime security implementation plan

**Status**: Completed
**Design Reference**: [Node.js October 2026 advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
**Created**: 2026-10-27
**Last Updated**: 2026-10-27

The published Node client currently accepts unpatched Node 22 installations. Require the supported patched Node release lines without changing the client API.

## TASK-001: Restrict the supported runtime range

**Status**: Completed
**Parallelizable**: Yes
**Dependencies**: None
**Deliverable**: `clients/node/package.json` engine metadata.

- [x] Require Node 22.23.4, 24.22.1 or 26.12.1 and later within those major versions.

## TASK-002: Validate client compatibility

**Status**: Completed
**Parallelizable**: No
**Dependencies**: TASK-001

- [x] Confirm vulnerable boundary versions are rejected and patched boundaries are accepted.
- [x] Run client type checking, tests and build with a patched runtime environment.

## Progress log

2026-10-27: Updated the package engine declaration; validating the client and supported version boundaries.

Validation: client typecheck and build passed; 42 tests passed; security version-boundary checks passed; the built client imports successfully on Node 22.23.4.
