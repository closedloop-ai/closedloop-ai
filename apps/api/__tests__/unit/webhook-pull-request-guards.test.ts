import { beforeEach, describe, expect, it, vi } from "vitest";
import { handlePullRequest } from "@/app/webhooks/github/handlers/pull-request-handler";
import {
  createPullRequest,
  createRepository,
  createSender,
} from "../fixtures/github-webhook-fixtures";

const mocks = vi.hoisted(() => ({
  persistActivity: vi.fn().mockResolvedValue({
    status: "persisted",
    persistenceStatus: "inserted",
  }),
  reconcileLabels: vi.fn().mockResolvedValue(undefined),
  withDbTx: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const withDb = vi.fn();
  Object.assign(withDb, { tx: mocks.withDbTx });
  return { ...actual, withDb };
});

vi.mock("@repo/github/artifact-reference-parser", () => ({
  parseArtifactReferences: vi.fn().mockReturnValue([]),
}));

vi.mock("@/app/branches/branch-service", () => ({
  branchService: { upsertBranchArtifact: vi.fn() },
}));

vi.mock(
  "@/app/webhooks/github/handlers/pull-request-label-reconciliation",
  () => ({
    reconcilePullRequestLabelsForWebhook: mocks.reconcileLabels,
  })
);

vi.mock("@/app/webhooks/github/handlers/branch-activity-producer", () => ({
  GitHubBranchActivityEventName: { PullRequest: "pull_request" },
  persistGitHubBranchActivity: mocks.persistActivity,
}));

describe("handlePullRequest guards", () => {
  const tx = {
    gitHubInstallationRepository: { findFirst: vi.fn() },
    pullRequestDetail: { findUnique: vi.fn() },
    branchDetail: { findFirst: vi.fn() },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withDbTx.mockImplementation((callback) => callback(tx));
    tx.gitHubInstallationRepository.findFirst.mockResolvedValue({
      fullName: "acme/widgets",
      id: "repo-uuid-exists",
      installation: { organizationId: null, installationId: "99" },
    });
    tx.pullRequestDetail.findUnique.mockResolvedValue(null);
    tx.branchDetail.findFirst.mockResolvedValue(null);
  });

  it("does not produce activity for a PR with no materialized Branch", async () => {
    const repository = createRepository(333);
    const pullRequest = createPullRequest({ number: 51, title: "Unknown PR" });

    await handlePullRequest({
      action: "reopened",
      number: pullRequest.number,
      pull_request: pullRequest,
      repository,
      sender: createSender(),
      installation: { id: 99 },
    } as never);

    expect(mocks.persistActivity).not.toHaveBeenCalled();
  });

  it("skips database and activity writes for an unsupported action", async () => {
    const repository = createRepository(444);
    const pullRequest = createPullRequest({ number: 52, title: "Labeled PR" });

    await handlePullRequest({
      action: "labeled",
      number: pullRequest.number,
      pull_request: pullRequest,
      repository,
      sender: createSender(),
      installation: { id: 99 },
    } as never);

    expect(mocks.withDbTx).not.toHaveBeenCalled();
    expect(mocks.persistActivity).not.toHaveBeenCalled();
  });
});
