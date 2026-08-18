/** The subset of a package manifest the staging helpers read. */
export type StagePackageManifest = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

/** One entry of the `dependencies` map from `pnpm list --prod --json --depth 0`. */
export type InstalledDependency = {
  version?: string;
  resolved?: string;
};

export declare function resolveStageDependencySpec(
  packageJson: StagePackageManifest,
  dependencyName: string,
  dependency: InstalledDependency,
  workspaceTarballSpecs: ReadonlyMap<string, string>
): string | undefined;

export declare function isBundledWorkspaceDependency(
  packageJson: StagePackageManifest,
  dependencyName: string,
  packedWorkspacePackageNames: ReadonlySet<string>
): boolean;

export declare function assertNoUnresolvedWorkspaceSpecs(
  stagePackageJson: StagePackageManifest
): void;

export declare function parseJsonFromCommandOutput(output: string): unknown;
