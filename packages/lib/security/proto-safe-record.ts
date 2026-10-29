/**
 * Re-export of the canonical `protoSafeRecord` from
 * `@repo/loops-api/security/proto-safe-record` (single source of truth). Kept
 * here so existing `@repo/lib/security/proto-safe-record` importers
 * (`apps/desktop`, `packages/app`) are unchanged.
 *
 * ISS-10178 moved the implementation into `@repo/loops-api`, which cannot
 * import `@repo/lib`: `@repo/loops-api -> @repo/lib -> @repo/api ->
 * @repo/loops-api` closes a workspace cycle. `@repo/loops-api` declares no
 * `@repo/*` dependencies, so it is the bottom of the graph and the only home
 * all three ISS-10178 sites can reach. Same constraint and same resolution as
 * `packages/loops-api/src/column-limits.ts` and `@repo/observability/truncate-utf8`.
 */
// biome-ignore lint/performance/noBarrelFile: thin SSOT re-export shim — keeps the existing `@repo/lib/security/proto-safe-record` import path stable while the implementation lives in `@repo/loops-api`.
export { protoSafeRecord } from "@repo/loops-api/security/proto-safe-record";
