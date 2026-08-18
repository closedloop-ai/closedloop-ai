/**
 * Type declarations for `generate-prisma-client-lib.mjs` (ISS-5303 — tooling
 * coverage reach). The lib is plain ESM JavaScript, so this sidecar is what lets
 * the typechecked `test/` project consume it without `allowJs`. Keep the
 * signatures in step with the `@ts-check` JSDoc on the implementation.
 */

/**
 * Hash the generator's inputs — repo-relative path AND bytes of each file —
 * into a single fingerprint anchored at `repoRoot`.
 */
export declare function inputFingerprint(
  filePaths: readonly string[],
  repoRoot: string
): string;

/**
 * Decide whether the already-generated client can be reused. Fail-closed: a
 * missing fingerprint file, a mismatched fingerprint, or any missing required
 * output all mean "regenerate".
 */
export declare function isGeneratedClientFresh(io: {
  fingerprintFile: string;
  generatedDir: string;
  requiredOutputs: readonly string[];
  fingerprintValue: string;
}): boolean;
