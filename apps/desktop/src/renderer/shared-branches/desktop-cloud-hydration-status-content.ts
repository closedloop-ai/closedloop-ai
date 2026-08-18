import { BranchCloudHydrationStatus } from "@repo/api/src/types/branch";
import type {
  DesktopStatusBannerTone,
  DesktopStatusBannerVariant,
} from "./desktop-status-banner";

/** Semantic tone plus copy for one cloud-hydration status on one surface. */
export type DesktopCloudHydrationStatusContent = {
  tone: DesktopStatusBannerTone;
  message: string;
};

/**
 * Per-variant, per-status tone + copy for the desktop branch cloud-hydration
 * banners, mirroring the sibling `CONNECT_STATUS_CONTENT` map.
 *
 * The list and detail surfaces previously carried their own near-identical
 * switch over this status (differing only in "branch data" vs "branch
 * details"), so a status added to one silently rendered nothing on the other —
 * exactly the parallel-switch drift the repo rules forbid. One map, two
 * variants (PLN-1535 M3.2).
 *
 * Statuses absent from a variant render nothing: `Fresh` is the happy path and
 * `NotConnected` is owned by the connect-GitHub CTA (`resolveBranchListBanner`
 * derives the same condition from `repoFullName`), not by this banner.
 */
const CLOUD_HYDRATION_STATUS_CONTENT: Record<
  DesktopStatusBannerVariant,
  Partial<
    Record<BranchCloudHydrationStatus, DesktopCloudHydrationStatusContent>
  >
> = {
  list: {
    [BranchCloudHydrationStatus.CredentialMissing]: {
      tone: "warning",
      message:
        "Sign in to ClosedLoop Desktop to sync GitHub data. Local branch data remains visible.",
    },
    [BranchCloudHydrationStatus.Failed]: {
      tone: "error",
      message:
        "GitHub cloud refresh failed. Local branch data remains visible.",
    },
    [BranchCloudHydrationStatus.Stale]: {
      tone: "warning",
      message:
        "GitHub cloud refresh failed. Showing the last synced GitHub overlay with local branch data.",
    },
  },
  detail: {
    [BranchCloudHydrationStatus.CredentialMissing]: {
      tone: "warning",
      message:
        "Sign in to ClosedLoop Desktop to sync GitHub data. Local branch details remain visible.",
    },
    [BranchCloudHydrationStatus.Failed]: {
      tone: "error",
      message:
        "GitHub cloud refresh failed. Local branch details remain visible.",
    },
    [BranchCloudHydrationStatus.Stale]: {
      tone: "warning",
      message:
        "GitHub cloud refresh failed. Showing the last synced GitHub overlay with local branch details.",
    },
  },
};

/**
 * Severity order for a list that mixes statuses across rows. A missing
 * credential outranks a failed refresh: nothing synced at all is a bigger
 * claim than one pass failing, and its remedy (sign in) is the precondition
 * for the others.
 */
const CLOUD_HYDRATION_STATUS_PRECEDENCE: readonly BranchCloudHydrationStatus[] =
  [
    BranchCloudHydrationStatus.CredentialMissing,
    BranchCloudHydrationStatus.Failed,
    BranchCloudHydrationStatus.Stale,
  ];

/** Banner content for one status on one surface, or null when it renders none. */
export function resolveCloudHydrationStatusContent(
  status: BranchCloudHydrationStatus | undefined,
  variant: DesktopStatusBannerVariant
): DesktopCloudHydrationStatusContent | null {
  if (!status) {
    return null;
  }
  return CLOUD_HYDRATION_STATUS_CONTENT[variant][status] ?? null;
}

/**
 * Banner content for a whole list of rows, taking the most severe status
 * present. Rows carry a per-pass status, so a mixed list is possible when
 * pages resolved under different credential states.
 */
export function resolveCloudHydrationListContent(
  rows: readonly { cloudHydrationStatus?: BranchCloudHydrationStatus }[]
): DesktopCloudHydrationStatusContent | null {
  const present = new Set(rows.map((row) => row.cloudHydrationStatus));
  const status = CLOUD_HYDRATION_STATUS_PRECEDENCE.find((candidate) =>
    present.has(candidate)
  );
  return resolveCloudHydrationStatusContent(status, "list");
}
