import type { PullRequestLabeledEvent } from "@octokit/webhooks-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deliverGitHubWebhook } from "@/__tests__/support/webhooks/github/github-webhook-route-delivery.test-helpers";
import {
  createPullRequestWebhookTx,
  type PullRequestWebhookTx,
} from "@/__tests__/support/webhooks/github/pull-request-handler.test-mocks";
import {
  HANDLED_ACTIONS,
  handlePullRequest,
  LINKAGE_ACTIONS,
} from "@/app/webhooks/github/handlers/pull-request-handler";
import {
  createHandledPullRequestEvent,
  createInstallationLite,
  createPullRequest,
  createPullRequestForAction,
  createPullRequestReopenedEvent,
  createRepository,
  createSender,
} from "../fixtures/github-webhook-fixtures";

const mocks = vi.hoisted(() => ({
  persistActivity: vi.fn(async () => ({
    status: "persisted",
    persistenceStatus: "inserted",
  })),
  publishDirtyScopes: vi.fn(async () => undefined),
  reconcileLabels: vi.fn(async () => undefined),
  withDbTx: vi.fn(),
  nextHeaders: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mocks.nextHeaders }));

// ISS-12463: the branch-owner seed is raw SQL this stubbed transaction does not
// model; its wiring is pinned by the real-Postgres seed-wiring suite.
vi.mock(
  "@/app/webhooks/github/handlers/pull-request-branch-owner-seed",
  () => ({
    seedPullRequestBranchOwner: vi.fn().mockResolvedValue(undefined),
  })
);

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const withDb = vi.fn();
  Object.assign(withDb, { tx: mocks.withDbTx });
  return { ...actual, withDb };
});

vi.mock("@repo/github/artifact-reference-parser", () => ({
  parseArtifactReferences: vi.fn(() => []),
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

vi.mock("@/app/webhooks/github/handlers/dirty-scope-publisher", () => ({
  publishGitHubDirtyScopes: mocks.publishDirtyScopes,
}));

describe("handlePullRequest guards", () => {
  let tx: PullRequestWebhookTx;

  beforeEach(() => {
    vi.clearAllMocks();
    // The canonical webhook tx stub, not a two-delegate hand stub: these cases
    // run with a real organization id (see below), which carries the handler
    // past the provider-identity advisory lock into the full delegate surface.
    tx = createPullRequestWebhookTx();
    mocks.withDbTx.mockImplementation((callback) => callback(tx));
    tx.gitHubInstallationRepository.findFirst.mockResolvedValue({
      fullName: "acme/widgets",
      id: "repo-uuid-exists",
      installation: { organizationId: ORG_ID, installationId: "99" },
    });
    tx.pullRequestDetail.findUnique.mockResolvedValue(null);
    tx.branchDetail.findFirst.mockResolvedValue(null);
  });

  it("does not produce activity for a PR with no materialized Branch", async () => {
    const repository = createRepository(333);
    const pullRequest = createPullRequest({ number: 51, title: "Unknown PR" });

    await handlePullRequest(
      createPullRequestReopenedEvent(pullRequest, { repository })
    );

    expect(mocks.persistActivity).not.toHaveBeenCalled();
    // Positive control for the non-linkage cases below: "reopened" is a
    // LINKAGE_ACTIONS member, so processMissingPullRequest takes the linkage
    // branch, which re-reads the pull request detail after attempting linkage.
    // That extra re-read is the whole signal — the non-linkage arm below makes
    // exactly one call fewer. Only the difference is load-bearing; the
    // absolute counts move whenever an unrelated lookup is added.
    expect(tx.pullRequestDetail.findUnique).toHaveBeenCalledTimes(3);
  });

  it("skips database and activity writes for an unsupported action", async () => {
    const repository = createRepository(444);
    const pullRequest = createPullRequest({ number: 52, title: "Labeled PR" });
    const event: PullRequestLabeledEvent = {
      action: "labeled",
      number: pullRequest.number,
      pull_request: pullRequest,
      label: {
        id: 208_045_946,
        node_id: "MDU6TGFiZWwyMDgwNDU5NDY=",
        url: "https://api.github.com/repos/owner/test-repo/labels/bug",
        name: "bug",
        description: "Something isn't working",
        color: "f29513",
        default: true,
      },
      repository,
      sender: createSender(),
      installation: createInstallationLite(),
    };

    // `labeled` is outside the handler's event type, so it arrives the way
    // GitHub sends it: through the route, which takes the raw body.
    const response = await deliverGitHubWebhook(mocks.nextHeaders, {
      eventType: "pull_request",
      payload: event,
    });

    // The handler's own skip answer, so a delivery the route refused cannot
    // pass the absence assertions below.
    await expect(response.json()).resolves.toEqual({
      message: "Ignoring unhandled pull_request action: labeled",
      ok: true,
    });
    expect(mocks.withDbTx).not.toHaveBeenCalled();
    expect(mocks.persistActivity).not.toHaveBeenCalled();
  });

  // Derived, not mirrored: a newly handled non-linkage action joins this table
  // on its own, where a hand-listed copy would leave it silently uncovered.
  const nonLinkageHandledActions = [...HANDLED_ACTIONS].filter(
    (action) => !LINKAGE_ACTIONS.has(action)
  );

  it.each(nonLinkageHandledActions)(
    "skips linkage and returns success for a missing PR on a non-linkage %s action",
    async (action) => {
      // The real organization id from the shared fixture is what makes the
      // publisher assertion below load-bearing: processPullRequestTransaction
      // withholds the publication on a null org whichever arm ran, so on a null
      // org this case would pass even if processMissingPullRequest reported
      // success.
      const repository = createRepository(555);
      const pullRequest = createPullRequestForAction(action, {
        number: 53,
        title: "Untracked PR",
      });

      const response = await handlePullRequest(
        createHandledPullRequestEvent(action, pullRequest, { repository })
      );

      expect(mocks.persistActivity).not.toHaveBeenCalled();
      expect(mocks.publishDirtyScopes).not.toHaveBeenCalled();
      // One call fewer than the "reopened" positive control above proves the
      // linkage branch's post-linkage re-read never ran.
      expect(tx.pullRequestDetail.findUnique).toHaveBeenCalledTimes(2);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ok: true });
    }
  );
});

const ORG_ID = "org-uuid-guards";
