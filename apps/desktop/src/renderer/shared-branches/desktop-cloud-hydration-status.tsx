import {
  BranchCloudHydrationStatus,
  type BranchRow,
} from "@repo/api/src/types/branch";
import {
  DesktopStatusBanner,
  type DesktopStatusBannerTone,
} from "./desktop-status-banner";

/** Honest cached/local fallback notice for partial Desktop cloud hydration. */
export function DesktopCloudHydrationStatus({ rows }: { rows: BranchRow[] }) {
  const state = resolveDesktopCloudHydrationState(rows);
  if (!state) {
    return null;
  }
  return (
    <DesktopStatusBanner tone={state.tone} variant="list">
      {state.message}
    </DesktopStatusBanner>
  );
}

function resolveDesktopCloudHydrationState(rows: BranchRow[]): {
  tone: DesktopStatusBannerTone;
  message: string;
} | null {
  if (
    rows.some(
      (row) => row.cloudHydrationStatus === BranchCloudHydrationStatus.Failed
    )
  ) {
    return {
      tone: "error",
      message:
        "GitHub cloud refresh failed. Local branch data remains visible.",
    };
  }
  if (
    rows.some(
      (row) => row.cloudHydrationStatus === BranchCloudHydrationStatus.Stale
    )
  ) {
    return {
      tone: "warning",
      message:
        "GitHub cloud refresh failed. Showing the last synced GitHub overlay with local branch data.",
    };
  }
  return null;
}
