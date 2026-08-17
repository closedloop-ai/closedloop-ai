/** One member of the packaged Desktop runtime workspace import closure. */
export type DesktopRuntimeClosureMember = {
  /** The npm package name, such as `@closedloop-ai/telemetry-contract`. */
  packageName: string;
  /** The directory name under `packages/`. */
  packageDir: string;
};

export declare const DESKTOP_RUNTIME_CLOSURE: readonly DesktopRuntimeClosureMember[];

export declare function resolveWorkspaceDependencyTarget(
  dependencyKey: string,
  sourceSpec: string
): string;

export declare function isWorkspaceProtocolSpec(spec: unknown): boolean;

export declare function resolveStagedPackageRuntimeFile(
  stageAppDir: string,
  packageName: string,
  relativeFile: string
): string;
