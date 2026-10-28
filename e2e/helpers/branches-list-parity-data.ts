/**
 * Dependency-free canonical corpus shared by the web and launched-Desktop
 * Branches List E2Es. Both harnesses derive their native transport/storage
 * fixtures from this one record so parity cannot drift behind different seeds.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Branch status evidence rendered from one shared web/Desktop corpus. */
export const BRANCH_STATUS_PARITY_SCENARIOS = [
  {
    branchName: "feature/iss-10422-status-review",
    id: "iss-10422-status-review",
    legacyLabel: "In review",
    rawStatus: "review",
    universalLabel: "Review",
  },
  {
    branchName: "feature/iss-10422-status-null",
    id: "iss-10422-status-null",
    legacyLabel: "Draft",
    rawStatus: null,
    universalLabel: "Unknown",
  },
  {
    branchName: "feature/iss-10422-status-future",
    id: "iss-10422-status-future",
    legacyLabel: "Draft",
    rawStatus: "awaiting_robot_review",
    universalLabel: "Unknown",
  },
] as const;

/** Build one internally consistent corpus from a single captured clock value. */
export function createBranchesListParityData(nowMs = Date.now()) {
  const repoFullName = "closedloop-ai/branches-parity";
  // ISS-7362: the List names a repo by its trailing segment while that segment
  // is unique across the rows in view (`repositoryDisplayLabels`), and this
  // corpus holds exactly one repo — so this is what the Repository cell and the
  // PR chip both render. Derived, not a second literal.
  const repoDisplayName = repoFullName.split("/").at(-1) ?? repoFullName;
  const olderActivityAt = new Date(nowMs - 45 * DAY_MS).toISOString();
  return {
    repoDisplayName,
    repoFullName,
    session: {
      id: "iss-4497-branches-list-parity-session",
      costUsd: 100,
    },
    churn: {
      additions: 500,
      deletions: 500,
      filesChanged: 12,
    },
    branches: {
      recent: {
        id: "iss-4497-branches-list-parity-recent",
        name: "feature/iss-4497-parity-recent",
        activityAt: new Date(nowMs - DAY_MS).toISOString(),
        lastActiveLabel: "Yesterday",
        prNumber: 44_971,
        prTitle: "Canonical Branches parity (recent)",
        prUrl: `https://github.com/${repoFullName}/pull/44971`,
      },
      older: {
        id: "iss-4497-branches-list-parity-older",
        name: "feature/iss-4497-parity-older",
        activityAt: olderActivityAt,
        lastActiveLabel: formatParityDate(olderActivityAt),
        prNumber: 44_972,
        prTitle: "Canonical Branches parity (older)",
        prUrl: `https://github.com/${repoFullName}/pull/44972`,
      },
    },
    expectations: {
      locPerDollarLabel: "LOC per $",
      allTimeLocPerDollar: "20 LOC/$",
      boundedLocPerDollar: "10 LOC/$",
    },
  } as const;
}

/** Match the List's viewer-local absolute-date fallback without app imports. */
function formatParityDate(instant: string): string {
  return new Date(instant).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
