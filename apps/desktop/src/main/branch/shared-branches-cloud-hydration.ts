import {
  BranchCloudHydrationStatus,
  type BranchRow,
} from "@repo/api/src/types/branch";
import type {
  BranchCloudHydrationOverlay,
  DesktopCloudGitHubHydration,
  DesktopCloudGitHubHydrationResult,
} from "../cloud/desktop-cloud-github-hydration.js";

export type BranchCloudHydrationSource = Pick<
  DesktopCloudGitHubHydration,
  "hydrate"
> &
  Partial<
    Pick<
      DesktopCloudGitHubHydration,
      "peekOrWarm" | "resolveRepositoryDefaultEligibilityInputs"
    >
  >;

/** Conservative production source used when no account credential path exists. */
export const FAIL_CLOSED_BRANCH_CLOUD_HYDRATION_SOURCE: BranchCloudHydrationSource =
  {
    hydrate: async () => ({
      status: BranchCloudHydrationStatus.NotConnected,
    }),
    peekOrWarm: async () => ({
      status: BranchCloudHydrationStatus.NotConnected,
    }),
    resolveRepositoryDefaultEligibilityInputs: async () => ({
      status: BranchCloudHydrationStatus.NotConnected,
      authorities: [],
    }),
  };

/** Apply an awaited eligibility result or acquire the best PR-field overlay. */
export async function applyCloudHydration<T extends BranchRow>(
  rows: T[],
  cloudHydration: BranchCloudHydrationSource | undefined,
  options: {
    forceRefresh?: boolean;
    resolvedResult?: DesktopCloudGitHubHydrationResult;
    scope: "list" | "detail";
  }
): Promise<T[]> {
  if (!cloudHydration || rows.length === 0) {
    return rows;
  }
  const result =
    options.resolvedResult ??
    (options.scope === "list" &&
    !options.forceRefresh &&
    cloudHydration.peekOrWarm
      ? await cloudHydration.peekOrWarm({ rows, scope: options.scope })
      : await cloudHydration.hydrate({
          rows,
          forceRefresh: options.forceRefresh,
          scope: options.scope,
        }));
  return rows.map((row) =>
    applyCloudHydrationResult(
      row,
      result.status,
      result.failure,
      result.overlays,
      options.scope
    )
  );
}

function applyCloudHydrationResult<T extends BranchRow>(
  row: T,
  status: BranchCloudHydrationStatus,
  failure: string | undefined,
  overlays: DesktopCloudGitHubHydrationResult["overlays"] | undefined,
  scope: "list" | "detail"
): T {
  const overlay = overlayForRow(row, overlays, scope);
  return {
    ...row,
    ...overlay,
    cloudHydrationStatus: status,
    ...(failure === undefined ? {} : { cloudHydrationFailure: failure }),
  };
}

function overlayForRow(
  row: BranchRow,
  overlays: DesktopCloudGitHubHydrationResult["overlays"] | undefined,
  scope: "list" | "detail"
): Partial<BranchRow> {
  if (!row.repoFullName || row.multiPrWarning || !overlays) {
    return {};
  }
  const overlay = overlays[`${row.repoFullName}::${row.branchName}`];
  if (!overlay) {
    return {};
  }
  return scope === "list"
    ? listSafeCloudOverlay(row, overlay)
    : detailSafeCloudOverlay(overlay);
}

/** Cloud no-PR projection cannot erase a numeric local PR observation. */
function listSafeCloudOverlay(
  row: BranchRow,
  overlay: BranchCloudHydrationOverlay
): BranchCloudHydrationOverlay {
  const safeOverlay = { ...overlay };
  // Canonical activity is projected across the full Desktop corpus before
  // paging. A page-local legacy overlay must not mutate that value afterward.
  Reflect.deleteProperty(safeOverlay, "lastActivityAt");
  if (typeof row.prNumber === "number" && overlay.prNumber === null) {
    Reflect.deleteProperty(safeOverlay, "prNumber");
  }
  return safeOverlay;
}

function detailSafeCloudOverlay(
  overlay: BranchCloudHydrationOverlay
): BranchCloudHydrationOverlay {
  const safeOverlay = { ...overlay };
  Reflect.deleteProperty(safeOverlay, "lastActivityAt");
  for (const key of detailIdentityOverlayKeys) {
    Reflect.deleteProperty(safeOverlay, key);
  }
  return safeOverlay;
}

const detailIdentityOverlayKeys = [
  "status",
  "prNumber",
  "prTitle",
  "prState",
  "prUrl",
  "reviewDecision",
] as const satisfies readonly (keyof BranchCloudHydrationOverlay)[];
