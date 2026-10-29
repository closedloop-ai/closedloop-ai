/**
 * ISS-7130: the `pull_request` webhook transaction takes the ISS-6980
 * PR-provider advisory lock, and `pg_advisory_xact_lock` blocks INSIDE the
 * waiter's own transaction — so the interactive-transaction `timeout`, not
 * `maxWait`, is what bounds the wait. Left on Prisma's 5s default, a delivery
 * contending with the 30s session-sync holder aborts with P2028 mid-wait and its
 * projection write is lost. The assertion is on the options the handler actually
 * opened its transaction with, so deleting them turns this red.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ChecksStatus: { UNKNOWN: "UNKNOWN", PENDING: "PENDING" },
  });
});
vi.mock("./pull-request-label-reconciliation", () => ({
  reconcilePullRequestLabelsForWebhook: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./dirty-scope-publisher", () => ({
  publishGitHubDirtyScopes: vi.fn().mockResolvedValue(undefined),
}));

import { getMockWithDb } from "@/__tests__/utils/db-helpers";
import { pullRequestProviderLockTxOptions } from "@/app/branches/pull-request-provider-lock";
import { handlePullRequest } from "./pull-request-handler";

/**
 * A `synchronize` delivery: handled, but outside `LINKAGE_ACTIONS`, so the
 * post-commit label reconcile stays out of the path this case is about.
 */
const event = {
  action: "synchronize",
  installation: { id: 4242 },
  pull_request: { number: 7, node_id: "PR_kwnode" },
  repository: { id: 909, full_name: "closedloop-ai/closedloop-ai" },
} as unknown as Parameters<typeof handlePullRequest>[0];

describe("handlePullRequest transaction bounds", () => {
  const mockWithDb = getMockWithDb();

  beforeEach(() => {
    vi.clearAllMocks();
    // Resolve without running the body: the bounds are chosen before the
    // callback runs, so the case needs no transaction-client fixture.
    mockWithDb.tx = vi.fn().mockResolvedValue(null);
  });

  it("sizes the webhook transaction to the PR-provider lock's worst-case holder", async () => {
    await handlePullRequest(event);

    expect(mockWithDb.tx).toHaveBeenCalledWith(
      expect.any(Function),
      pullRequestProviderLockTxOptions
    );
  });
});
