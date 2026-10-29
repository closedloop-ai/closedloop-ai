export type RuntimePackage = {
  name: string;
  version: string;
  snapshot: string;
};
export type RuntimePatchGraph = {
  packages: RuntimePackage[];
  signature: string;
};
export type RuntimePatchSelection = {
  graph: RuntimePatchGraph;
  patches: { selector: string; path: string }[];
};
export type PreparedRuntimePatches = {
  graph: RuntimePatchGraph;
  patches: { selector: string; path: string; hash: string }[];
};
/** Select source registrations against only the resolved staged production graph. */
export function selectStagedRuntimePatches(
  workspace: unknown,
  lockfile: unknown
): RuntimePatchSelection;
/** Preserve selected canonical registrations/assets before the real staged install. */
export function prepareStagedRuntimePatches(
  repoRoot: string,
  stageAppDir: string
): Promise<PreparedRuntimePatches>;
/** Check graph parity and applied source hashes after installation. */
export function verifyStagedRuntimePatches(
  stageAppDir: string,
  prepared: PreparedRuntimePatches
): Promise<void>;
