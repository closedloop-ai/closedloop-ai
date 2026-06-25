import os from "node:os";
import path from "node:path";

const STAGE_ROOT_NAME = "closedloop-desktop-packaging-stage";
const SAFE_STAGE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Resolve the packaging stage ID from GitHub Actions or the local default.
 *
 * The value becomes a recursive-delete root segment during package staging, so
 * it must stay a single bounded path segment before any filesystem mutation.
 */
function getPackagingStageId() {
  const stageId = process.env.GITHUB_RUN_ID ?? "local";
  if (!SAFE_STAGE_ID_PATTERN.test(stageId)) {
    throw new Error(
      `Unsafe packaging stage ID "${stageId}". Expected a single alphanumeric, underscore, or hyphen path segment.`
    );
  }
  return stageId;
}

/**
 * Return the root directory used to stage the Electron package.
 */
export function getPackagingStageRoot() {
  return path.join(os.tmpdir(), STAGE_ROOT_NAME, getPackagingStageId());
}

/**
 * Return the staged Electron app directory consumed by electron-builder.
 */
export function getPackagingStageAppDir() {
  return path.join(getPackagingStageRoot(), "app");
}
