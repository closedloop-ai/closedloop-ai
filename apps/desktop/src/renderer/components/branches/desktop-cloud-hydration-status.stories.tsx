import {
  BranchCloudHydrationStatus,
  type BranchRow,
  BranchStatus,
} from "@repo/api/src/types/branch";
import { DesktopCloudHydrationStatus } from "../../shared-branches/desktop-cloud-hydration-status";

/**
 * A banner for the desktop branches list that explains why the GitHub data
 * on screen might be out of date. It looks at every row's cloud sync state:
 * if any row failed to refresh, it shows an error toned banner, and if any
 * row is merely stale, it shows a warning toned one instead, always making
 * clear that the local branch data underneath is still visible. It renders
 * nothing when every row's cloud data is fresh, and a single failed row
 * takes priority over the rest even when most rows are just stale.
 */
const meta = {
  title: "Primitives/Feedback & Status/Cloud Hydration Status",
  component: DesktopCloudHydrationStatus,
  tags: ["autodocs"],
  argTypes: {
    rows: {
      control: "object",
      description:
        "Only `cloudHydrationStatus` is read, and a Failed row outranks a Stale one.",
    },
  },
  parameters: { layout: "padded" },
};

export default meta;

export const Fresh = {
  args: { rows: [makeRow(BranchCloudHydrationStatus.Fresh)] },
};

export const Stale = {
  args: { rows: [makeRow(BranchCloudHydrationStatus.Stale)] },
};

export const Failed = {
  args: { rows: [makeRow(BranchCloudHydrationStatus.Failed)] },
};

function makeRow(cloudHydrationStatus: BranchCloudHydrationStatus): BranchRow {
  return {
    id: `owner%2Frepo::${cloudHydrationStatus}`,
    branchName: `feature/${cloudHydrationStatus}`,
    baseBranch: "main",
    repoFullName: "owner/repo",
    owner: "alice",
    status: BranchStatus.Open,
    prNumber: null,
    prTitle: null,
    prState: null,
    prUrl: null,
    multiPrWarning: false,
    checksStatus: null,
    checksPassed: null,
    checksTotal: null,
    reviewDecision: null,
    ahead: null,
    behind: null,
    additions: null,
    deletions: null,
    filesChanged: null,
    estimatedCostUsd: null,
    lastActivityAt: "2026-08-05T00:00:00.000Z",
    sessionIds: [],
    cloudHydrationStatus,
  };
}
