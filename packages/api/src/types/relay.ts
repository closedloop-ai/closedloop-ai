/**
 * Shared Engineer routing modes across apps/app and apps/api.
 *
 * The single source of truth now lives in the workspace-only
 * `@repo/shared-platform` package, which every surface (web, desktop) can depend
 * on without a heavier `@repo/api`
 * dependency. This module re-exports it so the canonical in-repo import path
 * `@repo/api/src/types/relay` -- used across apps/app -- stays stable. Do NOT
 * redefine the const here.
 *
 * Contract source:
 * docs/artifacts/relay-integration-contracts.md
 */
// biome-ignore lint/performance/noBarrelFile: thin compatibility re-export of the EngineerRoutingMode SSOT, which now lives in @repo/shared-platform so it can be consumed cross-repo; keeps the canonical @repo/api/src/types/relay import path stable for apps/app.
export { EngineerRoutingMode } from "@repo/shared-platform/types";
