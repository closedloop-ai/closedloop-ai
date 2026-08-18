import {
  mapTagsToPullRequestLabels,
  PullRequestLabelLimit,
  TAG_COLOR_LABEL_HEX,
  TAG_LABEL_DESCRIPTION,
} from "@repo/api/src/types/pull-request-label";
import { PullRequestLabelSyncStatus } from "@repo/api/src/types/pull-request-label-sync-status";
import { TagColor } from "@repo/api/src/types/tag";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { Octokit } from "@octokit/rest";
import {
  ensureRepositoryLabelsExist,
  reconcilePullRequestLabels,
} from "../pull-request-labels";

const OWNER = "acme";
const REPO = "widgets";
const PULL_NUMBER = 42;
const TARGET = { owner: OWNER, repo: REPO, pullNumber: PULL_NUMBER };
const REPOSITORY = { owner: OWNER, repo: REPO };
const LABEL_ALREADY_EXISTS_STATUS = 422;

const listLabelsOnIssue = vi.fn();
const listLabelsForRepo = vi.fn();
const createLabel = vi.fn();
const addLabels = vi.fn();

/**
 * Minimal Octokit stand-in: the module only reaches into `rest.issues`, so a
 * structural stub keeps the test at the boundary the production code uses.
 */
function makeOctokit(): Octokit {
  return {
    rest: {
      issues: {
        listLabelsOnIssue,
        listLabelsForRepo,
        createLabel,
        addLabels,
      },
    },
  } as unknown as Octokit;
}

function labelPage(names: string[]) {
  return { data: names.map((name) => ({ name })) };
}

const INFRA_TAG = { name: "infra", color: TagColor.Blue };
const DOCS_TAG = { name: "docs", color: TagColor.Green };

beforeEach(() => {
  vi.clearAllMocks();
  listLabelsOnIssue.mockResolvedValue(labelPage([]));
  listLabelsForRepo.mockResolvedValue(labelPage([]));
  createLabel.mockResolvedValue({ data: {} });
  addLabels.mockResolvedValue({ data: [] });
});

describe("ensureRepositoryLabelsExist", () => {
  it("creates only the labels the repository is missing", async () => {
    listLabelsForRepo.mockResolvedValue(labelPage(["INFRA", "bug"]));

    const ensured = await ensureRepositoryLabelsExist(
      makeOctokit(),
      REPOSITORY,
      labelsFor([INFRA_TAG, DOCS_TAG])
    );

    expect(ensured).toEqual({ created: ["docs"], failed: [] });
    expect(createLabel).toHaveBeenCalledTimes(1);
    expect(createLabel).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      name: "docs",
      color: TAG_COLOR_LABEL_HEX[TagColor.Green],
      description: TAG_LABEL_DESCRIPTION,
    });
  });

  it("treats a concurrent create (422 already_exists) as success, not failure", async () => {
    createLabel.mockRejectedValue(
      Object.assign(new Error("Validation Failed"), {
        status: LABEL_ALREADY_EXISTS_STATUS,
      })
    );

    const ensured = await ensureRepositoryLabelsExist(
      makeOctokit(),
      REPOSITORY,
      labelsFor([INFRA_TAG])
    );

    expect(ensured).toEqual({ created: [], failed: [] });
  });

  it("reports a non-conflict create failure in `failed`, not `created`", async () => {
    createLabel.mockRejectedValue(
      Object.assign(new Error("Service Unavailable"), { status: 503 })
    );

    const ensured = await ensureRepositoryLabelsExist(
      makeOctokit(),
      REPOSITORY,
      labelsFor([INFRA_TAG])
    );

    expect(ensured).toEqual({ created: [], failed: ["infra"] });
  });

  it("reports unknown when the repository label read fails", async () => {
    listLabelsForRepo.mockRejectedValue(new Error("boom"));

    const ensured = await ensureRepositoryLabelsExist(
      makeOctokit(),
      REPOSITORY,
      labelsFor([INFRA_TAG])
    );

    expect(ensured).toBeNull();
    expect(createLabel).not.toHaveBeenCalled();
  });
});

describe("reconcilePullRequestLabels", () => {
  it("creates missing labels and adds them to the pull request", async () => {
    const result = await reconcilePullRequestLabels(
      makeOctokit(),
      TARGET,
      labelsFor([INFRA_TAG, DOCS_TAG])
    );

    expect(result.status).toBe(PullRequestLabelSyncStatus.Applied);
    expect(result.createdLabels).toEqual(["infra", "docs"]);
    expect(result.addedLabels).toEqual(["infra", "docs"]);
    expect(addLabels).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      issue_number: PULL_NUMBER,
      labels: ["infra", "docs"],
    });
  });

  // ISS-4762: the 26th label used to be discarded outright — the desired set
  // was truncated to one provider write. It must now land in a SECOND batch,
  // and the result must claim only what was really added.
  it("applies a set larger than one batch across successive writes", async () => {
    const count = PullRequestLabelLimit.ApplyBatchSize + 1;
    const tags = Array.from({ length: count }, (_unused, index) => ({
      name: `tag-${String(index).padStart(3, "0")}`,
      color: TagColor.Teal,
    }));

    const result = await reconcilePullRequestLabels(
      makeOctokit(),
      TARGET,
      labelsFor(tags)
    );

    expect(result.status).toBe(PullRequestLabelSyncStatus.Applied);
    expect(result.addedLabels).toHaveLength(count);
    expect(addLabels).toHaveBeenCalledTimes(2);
    expect(addLabels.mock.calls[0]?.[0].labels).toHaveLength(
      PullRequestLabelLimit.ApplyBatchSize
    );
    expect(addLabels.mock.calls[1]?.[0].labels).toEqual([
      `tag-${String(count - 1).padStart(3, "0")}`,
    ]);
  });

  // A later batch failing must not make the result claim the earlier ones
  // failed too — the PR really does carry them, and a retry recomputes.
  it("reports the batches that landed when a later batch fails", async () => {
    const count = PullRequestLabelLimit.ApplyBatchSize + 1;
    const tags = Array.from({ length: count }, (_unused, index) => ({
      name: `tag-${String(index).padStart(3, "0")}`,
      color: TagColor.Teal,
    }));
    addLabels
      .mockResolvedValueOnce({ data: [] })
      .mockRejectedValueOnce(new Error("provider unavailable"));

    const result = await reconcilePullRequestLabels(
      makeOctokit(),
      TARGET,
      labelsFor(tags)
    );

    expect(result.status).toBe(PullRequestLabelSyncStatus.Failed);
    expect(result.addedLabels).toHaveLength(
      PullRequestLabelLimit.ApplyBatchSize
    );
  });

  it("is a no-op on re-delivery once every tag label is present", async () => {
    listLabelsOnIssue.mockResolvedValue(labelPage(["infra", "docs"]));

    const result = await reconcilePullRequestLabels(
      makeOctokit(),
      TARGET,
      labelsFor([INFRA_TAG, DOCS_TAG])
    );

    expect(result.status).toBe(PullRequestLabelSyncStatus.NoOp);
    expect(createLabel).not.toHaveBeenCalled();
    expect(addLabels).not.toHaveBeenCalled();
  });

  it("does not clobber manually-added labels", async () => {
    listLabelsOnIssue.mockResolvedValue(
      labelPage(["needs-triage", "do-not-merge", "INFRA"])
    );
    listLabelsForRepo.mockResolvedValue(labelPage(["needs-triage", "infra"]));

    const result = await reconcilePullRequestLabels(
      makeOctokit(),
      TARGET,
      labelsFor([INFRA_TAG, DOCS_TAG])
    );

    // Only the genuinely-missing label is written, through the additive
    // endpoint — the manual labels are never named in the request.
    expect(result.addedLabels).toEqual(["docs"]);
    expect(addLabels).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      issue_number: PULL_NUMBER,
      labels: ["docs"],
    });
  });

  it("does nothing when the artifact carries no tags", async () => {
    const result = await reconcilePullRequestLabels(makeOctokit(), TARGET, []);

    expect(result.status).toBe(PullRequestLabelSyncStatus.NoOp);
    expect(listLabelsOnIssue).not.toHaveBeenCalled();
    expect(addLabels).not.toHaveBeenCalled();
  });

  it("fails closed (writes nothing) when the PR label read fails", async () => {
    listLabelsOnIssue.mockRejectedValue(new Error("rate limited"));

    const result = await reconcilePullRequestLabels(
      makeOctokit(),
      TARGET,
      labelsFor([INFRA_TAG])
    );

    expect(result.status).toBe(PullRequestLabelSyncStatus.Failed);
    expect(createLabel).not.toHaveBeenCalled();
    expect(addLabels).not.toHaveBeenCalled();
  });

  it("reports failure without throwing when the label write is rejected", async () => {
    addLabels.mockRejectedValue(new Error("forbidden"));

    const result = await reconcilePullRequestLabels(
      makeOctokit(),
      TARGET,
      labelsFor([INFRA_TAG])
    );

    expect(result.status).toBe(PullRequestLabelSyncStatus.Failed);
    expect(result.addedLabels).toEqual([]);
  });

  it("excludes a label whose create failed transiently from the add batch", async () => {
    // `infra` creates cleanly; `docs` hits a non-conflict 503. The old code
    // still sent both to addLabels, and the missing `docs` 422s the whole
    // batch — dropping the valid `infra` too. It must now add only `infra`.
    createLabel.mockImplementation((args: { name: string }) => {
      if (args.name === "docs") {
        return Promise.reject(
          Object.assign(new Error("Service Unavailable"), { status: 503 })
        );
      }
      return Promise.resolve({ data: {} });
    });

    const result = await reconcilePullRequestLabels(
      makeOctokit(),
      TARGET,
      labelsFor([INFRA_TAG, DOCS_TAG])
    );

    expect(addLabels).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      issue_number: PULL_NUMBER,
      labels: ["infra"],
    });
    expect(result.addedLabels).toEqual(["infra"]);
    // The pass did not fully converge, so it reports Failed to invite a retry.
    expect(result.status).toBe(PullRequestLabelSyncStatus.Failed);
  });

  it("fails without writing when every missing label's create failed", async () => {
    createLabel.mockRejectedValue(
      Object.assign(new Error("Service Unavailable"), { status: 503 })
    );

    const result = await reconcilePullRequestLabels(
      makeOctokit(),
      TARGET,
      labelsFor([INFRA_TAG])
    );

    expect(addLabels).not.toHaveBeenCalled();
    expect(result.status).toBe(PullRequestLabelSyncStatus.Failed);
    expect(result.addedLabels).toEqual([]);
  });

  it("pages the pull request label read past the first page", async () => {
    const firstPage = Array.from({ length: 100 }, (_u, i) => `existing-${i}`);
    listLabelsOnIssue
      .mockResolvedValueOnce(labelPage(firstPage))
      .mockResolvedValueOnce(labelPage(["infra"]));

    const result = await reconcilePullRequestLabels(
      makeOctokit(),
      TARGET,
      labelsFor([INFRA_TAG])
    );

    expect(listLabelsOnIssue).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(PullRequestLabelSyncStatus.NoOp);
  });
});

/**
 * The mapper returns `{ labels, droppedTagNames }` (ISS-4762). These suites
 * exercise the provider pass, not the ceiling, so they take the labels.
 */
function labelsFor(tags: Parameters<typeof mapTagsToPullRequestLabels>[0]) {
  return mapTagsToPullRequestLabels(tags).labels;
}
