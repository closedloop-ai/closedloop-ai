/**
 * @file usage-dedup.ts
 * @description Re-export shim. The Claude usage-dedup accumulator (FEA-1459) was
 * extracted to the browser-safe harness slice of `@repo/lib` (FEA-2717) so
 * the collector boot-import and the `database/transcript.ts` live-hook path
 * share one implementation. This path stays stable for those consumers.
 */
// biome-ignore lint/performance/noBarrelFile: re-export shim for the extracted @repo/lib/harness module (FEA-2717)
export * from "@repo/lib/harness/usage-dedup";
