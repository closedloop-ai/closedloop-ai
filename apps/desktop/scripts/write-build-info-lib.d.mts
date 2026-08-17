/**
 * Type declarations for `write-build-info-lib.mjs` (ISS-5303 — tooling coverage
 * reach). The lib is plain ESM JavaScript, so this sidecar is what lets the
 * typechecked `test/` project consume it without `allowJs`. Keep the signatures
 * in step with the `@ts-check` JSDoc on the implementation.
 */

export declare const BuildInfoWriteOutcome: {
  readonly Unchanged: "unchanged";
  readonly Wrote: "wrote";
};

export type BuildInfoWriteOutcome =
  (typeof BuildInfoWriteOutcome)[keyof typeof BuildInfoWriteOutcome];

export type BuildInfoWriteResult = {
  outcome: BuildInfoWriteOutcome;
  message: string;
};

/**
 * Render the generated `build-info.ts` source.
 */
export declare function renderBuildInfoSource(fields: {
  commitHash: string;
  appVersion: string;
}): string;

/**
 * Pull the app version out of a parsed `package.json`, degrading a missing or
 * non-string `version` to `""`.
 */
export declare function resolveAppVersion(packageJson: unknown): string;

/**
 * Write the generated source only when its bytes would change.
 */
export declare function writeBuildInfoIfChanged(io: {
  outFile: string;
  contents: string;
  displayPath: string;
}): BuildInfoWriteResult;
