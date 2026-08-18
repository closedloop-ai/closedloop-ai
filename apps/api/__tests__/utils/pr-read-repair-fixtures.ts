import { GitHubPRState } from "@repo/api/src/types/github";
import type { PrReadRepairInput } from "@/lib/pr-read-repair";

export const PR_READ_REPAIR_ORG_ID = "org-uuid-test";

/** Baseline eligible repair input; override only what a case is about. */
export function makePrReadRepairInput(
  overrides: Partial<PrReadRepairInput> = {}
): PrReadRepairInput {
  return {
    id: "link-uuid-1",
    externalUrl: "https://github.com/acme/my-repo/pull/42",
    projectId: "proj-uuid-1",
    organizationId: PR_READ_REPAIR_ORG_ID,
    prState: GitHubPRState.Open,
    lastVerifiedAt: null,
    lastRefreshAttemptAt: null,
    ...overrides,
  };
}
