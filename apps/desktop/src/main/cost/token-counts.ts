/**
 * @file token-counts.ts
 * @description Re-export shim. The storage-bound token-count helpers were
 * extracted to the browser-safe harness slice of `@repo/lib` (FEA-2717) so
 * the desktop collectors and the cloud transcript renderer share one
 * implementation. This module keeps the historical `main/token-counts` import
 * path stable for its many desktop consumers (DB layer, all parsers, OTel).
 */
// biome-ignore lint/performance/noBarrelFile: re-export shim for the extracted @repo/lib/harness module (FEA-2717)
export * from "@repo/lib/harness/token-counts";
