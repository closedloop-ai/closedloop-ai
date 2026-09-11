import {
  BranchCloudHydrationStatus,
  type BranchRow,
  BranchStatus,
} from "@repo/api/src/types/branch";
import { DesktopCloudHydrationStatus } from "../../shared-branches/desktop-cloud-hydration-status";

/**
 * A banner in the desktop branches list warning that GitHub data may be out
 * of date, showing an error tone if any row failed to refresh or a warning
 * tone if data is merely stale.
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
