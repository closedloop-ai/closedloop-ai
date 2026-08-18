/**
 * Dependency-free canonical corpus shared by the web and launched-Desktop
 * Branches List E2Es. Both harnesses derive their native transport/storage
 * fixtures from this one record so parity cannot drift behind different seeds.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Build one internally consistent corpus from a single captured clock value. */
export function createBranchesListParityData(nowMs = Date.now()) {
  const repoFullName = "closedloop-ai/branches-parity";
  const olderActivityAt = new Date(nowMs - 45 * DAY_MS).toISOString();
  return {
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
      aiSpendLabel: "AI spend",
      allTimeSpend: "—",
      boundedSpend: "—",
      locPerDollarLabel: "LOC per $",
      allTimeLocPerDollar: "N/A",
      boundedLocPerDollar: "—",
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
