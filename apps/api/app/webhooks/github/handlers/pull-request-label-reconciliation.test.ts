import { ArtifactSubtype, LinkType } from "@repo/api/src/types/artifact";
import { PullRequestLabelSyncStatus } from "@repo/api/src/types/pull-request-label-sync-status";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
  syncPullRequestLabelsFromArtifactTags: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  return {
    ...actual,
    withDb: mocks.withDb,
  };
});

vi.mock("@/lib/github/pull-request-label-sync", () => ({
  syncPullRequestLabelsFromArtifactTags:
    mocks.syncPullRequestLabelsFromArtifactTags,
}));

vi.mock("@repo/observability/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { reconcilePullRequestLabelsForWebhook } from "./pull-request-label-reconciliation";

const INPUT = {
  githubRepoId: "555",
  repositoryFullName: "acme/widgets",
  installationId: "install-9",
  pullNumber: 42,
};

const REPOSITORY_ROW = {
  id: "repo-1",
  owner: "acme",
  name: "widgets",
  installation: { organizationId: "org-1" },
};

type FakeDb = {
  gitHubInstallationRepository: { findFirst: ReturnType<typeof vi.fn> };
  pullRequestDetail: { findUnique: ReturnType<typeof vi.fn> };
};

function installDb(db: FakeDb) {
  mocks.withDb.mockImplementation((cb: (client: FakeDb) => unknown) =>
    Promise.resolve(cb(db))
  );
  return db;
}

function makeDb(options: {
  repository?: typeof REPOSITORY_ROW | null;
  detail?: unknown;
}): FakeDb {
  return installDb({
    gitHubInstallationRepository: {
      findFirst: vi.fn(() =>
        Promise.resolve(
          options.repository === undefined ? REPOSITORY_ROW : options.repository
        )
      ),
    },
    pullRequestDetail: {
      findUnique: vi.fn(() => Promise.resolve(options.detail ?? null)),
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.syncPullRequestLabelsFromArtifactTags.mockResolvedValue({
    status: PullRequestLabelSyncStatus.Applied,
    createdLabels: ["infra"],
    addedLabels: ["infra"],
    droppedLabels: [],
  });
});

describe("reconcilePullRequestLabelsForWebhook", () => {
  it("syncs the branch-linked document's tags onto the pull request", async () => {
    makeDb({
      detail: {
        artifact: null,
        branchArtifact: {
          projectId: "project-1",
          targetLinks: [{ sourceId: "doc-1" }],
        },
      },
    });

    const result = await reconcilePullRequestLabelsForWebhook(INPUT);

    expect(result.status).toBe(PullRequestLabelSyncStatus.Applied);
    expect(mocks.syncPullRequestLabelsFromArtifactTags).toHaveBeenCalledWith({
      organizationId: "org-1",
      projectId: "project-1",
      artifactId: "doc-1",
      installationId: "install-9",
      owner: "acme",
      repo: "widgets",
      pullNumber: 42,
    });
  });

  it("falls back to the legacy PR-owned artifact linkage", async () => {
    makeDb({
      detail: {
        artifact: {
          projectId: "project-1",
          targetLinks: [{ sourceId: "legacy-doc" }],
        },
        branchArtifact: null,
      },
    });

    await reconcilePullRequestLabelsForWebhook(INPUT);

    expect(mocks.syncPullRequestLabelsFromArtifactTags).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: "legacy-doc" })
    );
  });

  it("scopes the produces-link read to DOCUMENT sources", async () => {
    const db = makeDb({
      detail: {
        artifact: null,
        branchArtifact: {
          projectId: "project-1",
          targetLinks: [{ sourceId: "doc-1" }],
        },
      },
    });

    await reconcilePullRequestLabelsForWebhook(INPUT);

    const select = db.pullRequestDetail.findUnique.mock.calls[0][0].select;
    expect(select.branchArtifact.select.targetLinks.where.linkType).toBe(
      LinkType.Produces
    );
  });

  it("skips silently when the PR has no linked document", async () => {
    makeDb({ detail: { artifact: null, branchArtifact: null } });

    const result = await reconcilePullRequestLabelsForWebhook(INPUT);

    expect(result.status).toBe(PullRequestLabelSyncStatus.NoOp);
    expect(mocks.syncPullRequestLabelsFromArtifactTags).not.toHaveBeenCalled();
  });

  it("skips silently when the repository is not an active installation repo", async () => {
    makeDb({ repository: null });

    const result = await reconcilePullRequestLabelsForWebhook(INPUT);

    expect(result.status).toBe(PullRequestLabelSyncStatus.NoOp);
    expect(mocks.syncPullRequestLabelsFromArtifactTags).not.toHaveBeenCalled();
  });

  it("resolves Failed instead of throwing when the label sync blows up", async () => {
    // Same posture as the link-creation caller: this runs after the
    // pull_request transaction committed, so a throw would 500 the webhook and
    // make GitHub retry work that already succeeded.
    makeDb({
      detail: {
        artifact: null,
        branchArtifact: {
          projectId: "project-1",
          targetLinks: [{ sourceId: "doc-1" }],
        },
      },
    });
    mocks.syncPullRequestLabelsFromArtifactTags.mockRejectedValue(
      new Error("github unavailable")
    );

    const result = await reconcilePullRequestLabelsForWebhook(INPUT);

    expect(result.status).toBe(PullRequestLabelSyncStatus.Failed);
  });

  it("resolves Failed instead of throwing when the context read blows up", async () => {
    // The context reads run after the pull_request transaction committed, so a
    // throw here would 500 the webhook and make GitHub retry work that already
    // succeeded.
    mocks.withDb.mockRejectedValue(new Error("connection terminated"));

    const result = await reconcilePullRequestLabelsForWebhook(INPUT);

    expect(result.status).toBe(PullRequestLabelSyncStatus.Failed);
    expect(mocks.syncPullRequestLabelsFromArtifactTags).not.toHaveBeenCalled();
  });

  // ISS-4760 single label-source identity: the link-PR dialog gives the PLAN the
  // produces-link and the ISSUE the tags. Reading the link owner directly made
  // this path label the PR from PLAN tags while the tag-mutation path labelled
  // it from the issue's — one PR, two answers.
  it("labels a plan-owned link from the issue that produces the plan", async () => {
    makeDb({
      detail: {
        artifact: null,
        branchArtifact: {
          projectId: "project-1",
          targetLinks: [
            {
              sourceId: "plan-1",
              source: {
                subtype: ArtifactSubtype.ImplementationPlan,
                targetLinks: [{ sourceId: "issue-1" }],
              },
            },
          ],
        },
      },
    });

    await reconcilePullRequestLabelsForWebhook(INPUT);

    expect(mocks.syncPullRequestLabelsFromArtifactTags).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: "issue-1" })
    );
  });
});
