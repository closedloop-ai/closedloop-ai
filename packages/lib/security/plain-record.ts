/**
 * Re-export of the canonical `isPlainRecord` from
 * `@repo/loops-api/security/plain-record` (single source of truth). Kept here
 * so existing `@repo/lib/security/plain-record` importers (`apps/desktop`) are
 * unchanged. It travelled with `protoSafeRecord` in ISS-10178 because that
 * codec gates on it; see the sibling shim for why the implementation moved.
 */
// biome-ignore lint/performance/noBarrelFile: thin SSOT re-export shim — keeps the existing `@repo/lib/security/plain-record` import path stable while the implementation lives in `@repo/loops-api`.
export { isPlainRecord } from "@repo/loops-api/security/plain-record";
