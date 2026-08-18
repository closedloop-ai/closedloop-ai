import {
  PullRequestLabelLimit,
  TAG_COLOR_LABEL_HEX,
  TAG_LABEL_DESCRIPTION,
} from "@repo/api/src/types/pull-request-label";
import { PullRequestLabelSyncStatus } from "@repo/api/src/types/pull-request-label-sync-status";
import { TagColor } from "@repo/api/src/types/tag";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
  getInstallationOctokit: vi.fn(),
  reconcilePullRequestLabels: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

vi.mock("@repo/github/installation-auth", () => ({
  getInstallationOctokit: mocks.getInstallationOctokit,
}));

vi.mock("@repo/github/pull-request-labels", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@repo/github/pull-request-labels")>();
  return {
    ...actual,
    reconcilePullRequestLabels: mocks.reconcilePullRequestLabels,
  };
});

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  resolveArtifactTagLabels,
  syncPullRequestLabelsFromArtifactTags,
} from "@/lib/github/pull-request-label-sync";

const INPUT = {
  organizationId: "org-1",
  projectId: "project-1",
  artifactId: "artifact-1",
  installationId: "install-9",
  owner: "acme",
  repo: "widgets",
  pullNumber: 42,
};

const OCTOKIT = { marker: "installation-octokit" };

/**
 * Install a DB stub whose artifact lookup either validates the tag source
 * (ISS-4759) or rejects it, and whose tag read returns `rows`.
 */
function installTagSource(options: {
  rows: Array<{ name: string; color: string }>;
  valid?: boolean;
}) {
  const findFirst = vi.fn(() =>
    Promise.resolve(options.valid === false ? null : { id: "artifact-1" })
  );
  const findMany = vi.fn(() =>
    Promise.resolve(options.rows.map((tag) => ({ tag })))
  );
  mocks.withDb.mockImplementation((cb: (client: unknown) => unknown) =>
    Promise.resolve(cb({ artifact: { findFirst }, tagArtifact: { findMany } }))
  );
  return { findFirst, findMany };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getInstallationOctokit.mockResolvedValue(OCTOKIT);
  mocks.reconcilePullRequestLabels.mockResolvedValue({
    status: PullRequestLabelSyncStatus.Applied,
    createdLabels: [],
    addedLabels: ["infra"],
    droppedLabels: [],
  });
});

describe("resolveArtifactTagLabels", () => {
  it("scopes the tag read to the organization and the artifact", async () => {
    const { findMany } = installTagSource({ rows: [] });

    await resolveArtifactTagLabels({
      organizationId: "org-1",
      projectId: "project-1",
      artifactId: "artifact-1",
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          artifactId: "artifact-1",
          tag: { organizationId: "org-1" },
        },
      })
    );
  });

  // ISS-4759: an org-only filter let a caller name ANY same-org artifact — a
  // different project's, a non-DOCUMENT, a subtype that implements nothing —
  // and have its taxonomy painted onto this repository's PR.
  it("constrains the tag source to a same-project implementing document", async () => {
    const { findFirst } = installTagSource({ rows: [] });

    await resolveArtifactTagLabels({
      organizationId: "org-1",
      projectId: "project-1",
      artifactId: "artifact-1",
    });

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "artifact-1",
          organizationId: "org-1",
          projectId: "project-1",
        }),
      })
    );
  });

  it("returns null — not an empty tag set — for a rejected source", async () => {
    const { findMany } = installTagSource({ rows: [], valid: false });

    const mapping = await resolveArtifactTagLabels({
      organizationId: "org-1",
      projectId: "other-project",
      artifactId: "artifact-1",
    });

    expect(mapping).toBeNull();
    // The tag read never even runs, so a rejected source cannot leak which
    // tags another project's artifact carries.
    expect(findMany).not.toHaveBeenCalled();
  });

  it("maps stored tags onto GitHub label specs", async () => {
    installTagSource({ rows: [{ name: "infra", color: TagColor.Blue }] });

    const mapping = await resolveArtifactTagLabels({
      organizationId: "org-1",
      projectId: "project-1",
      artifactId: "artifact-1",
    });

    expect(mapping?.labels).toEqual([
      {
        name: "infra",
        color: TAG_COLOR_LABEL_HEX[TagColor.Blue],
        description: TAG_LABEL_DESCRIPTION,
      },
    ]);
    expect(mapping?.droppedTagNames).toEqual([]);
  });
});

describe("syncPullRequestLabelsFromArtifactTags", () => {
  it("applies every tag on the artifact to the pull request", async () => {
    installTagSource({
      rows: [
        { name: "infra", color: TagColor.Blue },
        { name: "docs", color: TagColor.Green },
      ],
    });

    const result = await syncPullRequestLabelsFromArtifactTags(INPUT);

    expect(result.status).toBe(PullRequestLabelSyncStatus.Applied);
    expect(mocks.getInstallationOctokit).toHaveBeenCalledWith("install-9");
    expect(mocks.reconcilePullRequestLabels).toHaveBeenCalledWith(
      OCTOKIT,
      { owner: "acme", repo: "widgets", pullNumber: 42 },
      [
        {
          name: "infra",
          color: TAG_COLOR_LABEL_HEX[TagColor.Blue],
          description: TAG_LABEL_DESCRIPTION,
        },
        {
          name: "docs",
          color: TAG_COLOR_LABEL_HEX[TagColor.Green],
          description: TAG_LABEL_DESCRIPTION,
        },
      ]
    );
  });

  // ISS-4759: a rejected source must make NO GitHub mutation, and must say so
  // with a status a caller can tell apart from a retriable provider failure.
  it("makes no GitHub call for a tag source that does not validate", async () => {
    installTagSource({
      rows: [{ name: "infra", color: TagColor.Blue }],
      valid: false,
    });

    const result = await syncPullRequestLabelsFromArtifactTags(INPUT);

    expect(result.status).toBe(PullRequestLabelSyncStatus.SourceRejected);
    expect(mocks.getInstallationOctokit).not.toHaveBeenCalled();
    expect(mocks.reconcilePullRequestLabels).not.toHaveBeenCalled();
  });

  // ISS-4762: the artifact carries more tags than the ceiling allows. The pass
  // must send the ceiling's worth AND report the remainder, never return a
  // clean "Applied" that reads as "all of them".
  it("reports the tags the ceiling refused alongside the applied ones", async () => {
    const overflow = 2;
    const rows = Array.from(
      { length: PullRequestLabelLimit.MaxLabelsPerPullRequest + overflow },
      (_unused, index) => ({
        name: `tag-${String(index).padStart(3, "0")}`,
        color: TagColor.Teal,
      })
    );
    installTagSource({ rows });

    const result = await syncPullRequestLabelsFromArtifactTags(INPUT);

    expect(result.droppedLabels).toHaveLength(overflow);
    const sent = mocks.reconcilePullRequestLabels.mock.calls[0]?.[2];
    expect(sent).toHaveLength(PullRequestLabelLimit.MaxLabelsPerPullRequest);
  });

  it("skips GitHub entirely when the artifact has no tags", async () => {
    installTagSource({ rows: [] });

    const result = await syncPullRequestLabelsFromArtifactTags(INPUT);

    expect(result.status).toBe(PullRequestLabelSyncStatus.NoOp);
    expect(mocks.getInstallationOctokit).not.toHaveBeenCalled();
    expect(mocks.reconcilePullRequestLabels).not.toHaveBeenCalled();
  });

  it("never throws when GitHub credential resolution fails", async () => {
    installTagSource({ rows: [{ name: "infra", color: TagColor.Blue }] });
    mocks.getInstallationOctokit.mockRejectedValue(new Error("no install"));

    const result = await syncPullRequestLabelsFromArtifactTags(INPUT);

    expect(result.status).toBe(PullRequestLabelSyncStatus.Failed);
    expect(result.addedLabels).toEqual([]);
  });

  it("never throws when the tag read fails", async () => {
    mocks.withDb.mockRejectedValue(new Error("db down"));

    const result = await syncPullRequestLabelsFromArtifactTags(INPUT);

    expect(result.status).toBe(PullRequestLabelSyncStatus.Failed);
  });
});
