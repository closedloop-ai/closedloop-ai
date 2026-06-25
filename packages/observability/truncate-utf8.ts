/**
 * Re-export of the canonical `truncateUtf8` from
 * `@closedloop-ai/loops-api/observability` (single source of truth). Kept here so
 * existing `@repo/observability/truncate-utf8` importers (apps/api) are unchanged.
 */
// biome-ignore lint/performance/noBarrelFile: thin SSOT re-export shim — keeps the existing `@repo/observability/truncate-utf8` import path stable while the implementation lives in `@closedloop-ai/loops-api`.
export { truncateUtf8 } from "@closedloop-ai/loops-api/observability";
