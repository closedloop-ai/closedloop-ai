/**
 * @file type-guards.ts
 * @description Re-export shim. `isRecord`/`asRecord` were extracted to the
 * browser-safe harness slice of `@repo/lib` (FEA-2717) — the Codex parser
 * core depends on them — while this historical `shared/type-guards` import path
 * stays stable for its desktop consumers.
 */
// biome-ignore lint/performance/noBarrelFile: re-export shim for the extracted @repo/lib/harness module (FEA-2717)
export * from "@repo/lib/harness/type-guards";
