import { PreviewResetMode } from "./migrate-deploy-recovery";
import { isPreviewSchema } from "./preview-schema";
import { isRetainedEnvironmentSchema } from "./vibe-environment-retention";

/**
 * ISS-12135: unattended recovery must not erase a retained environment. A
 * freshly rebuilt schema from an explicit mode request has no rows to preserve.
 */
export function selectPreviewResetMode({
  schema,
  branch,
  cloneFirst = false,
  isNew = false,
  vibeEnvironmentRebuilt = false,
}: {
  schema: string | null;
  branch: string | undefined;
  cloneFirst?: boolean;
  isNew?: boolean;
  vibeEnvironmentRebuilt?: boolean;
}): PreviewResetMode {
  const explicitFreshBuild = isNew && vibeEnvironmentRebuilt;
  if (
    schema !== null &&
    isPreviewSchema(schema) &&
    isRetainedEnvironmentSchema(schema, branch) &&
    !explicitFreshBuild
  ) {
    return PreviewResetMode.Never;
  }
  return cloneFirst ? PreviewResetMode.ResetOnly : PreviewResetMode.Remigrate;
}
