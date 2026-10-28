/**
 * ISS-12344 decision record (comment thread th_1__bTDiF9jNPx9ebLHmn0, Perrin
 * Upcott 2026-10-09): once a GitHub read has filed a PR under its head, a
 * later desktop sync carrying a different head must not re-file it, from any
 * desktop build. A PR GitHub has not read keeps today's desktop filing.
 *
 * Driven through the real sync service over the in-memory PR-detail harness,
 * whose row store keys on the production identity and never echoes a query.
 */
import { ArtifactType } from "@repo/api/src/types/artifact";
import { GitHubFetchMechanism } from "@repo/api/src/types/github-read-model";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PR_DETAIL_BRANCH_ARTIFACT_ID as COMMAND_BRANCH_ARTIFACT_ID,
  installPrDetailIngestDb,
  prDetailRef,
  type SeededPrDetailRow,
  syncPrDetailRefs,
} from "@/__tests__/support/agent-sessions/service.test-harness-pr-detail";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

describe("desktop PR lane after a GitHub-head move", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not re-file a PR GitHub filed under its head when a later sync carries the command's head", async () => {
    const m = installPrDetailIngestDb({
      pullRequestDetails: [movedRow(42, HEAD_A_BRANCH_ARTIFACT_ID)],
      branches: BRANCHES,
    });

    await syncPrDetailRefs([prDetailRef()]);

    expect(branchOf(m.rows, 42)).toBe(HEAD_A_BRANCH_ARTIFACT_ID);
    expect(m.prCreateMany).not.toHaveBeenCalled();
    expect(m.prUpdateMany).not.toHaveBeenCalled();
    expect(branchCreates(m.artifactCreate)).toHaveLength(0);
  });

  it("does not re-file it from an installed build's minimal payload either", async () => {
    const m = installPrDetailIngestDb({
      pullRequestDetails: [movedRow(42, HEAD_A_BRANCH_ARTIFACT_ID)],
      branches: BRANCHES,
    });

    await syncPrDetailRefs([installedBuildRef(42)]);

    expect(branchOf(m.rows, 42)).toBe(HEAD_A_BRANCH_ARTIFACT_ID);
    expect(m.prCreateMany).not.toHaveBeenCalled();
    expect(m.prUpdateMany).not.toHaveBeenCalled();
  });

  it("files an unread PR from an installed build's minimal payload", async () => {
    const m = installPrDetailIngestDb({ branches: BRANCHES });

    await syncPrDetailRefs([installedBuildRef(42)]);

    expect(m.prCreateMany).toHaveBeenCalledTimes(1);
    expect(branchOf(m.rows, 42)).toBe(COMMAND_BRANCH_ARTIFACT_ID);
  });

  it("keeps each of two PRs one command opened under its own GitHub head", async () => {
    const m = installPrDetailIngestDb({
      pullRequestDetails: [
        movedRow(42, HEAD_A_BRANCH_ARTIFACT_ID),
        movedRow(43, HEAD_B_BRANCH_ARTIFACT_ID),
      ],
      branches: BRANCHES,
    });

    // The command gave both PRs its one head.
    await syncPrDetailRefs([
      prDetailRef({ prNumber: 42 }),
      prDetailRef({ prNumber: 43 }),
    ]);

    expect(branchOf(m.rows, 42)).toBe(HEAD_A_BRANCH_ARTIFACT_ID);
    expect(branchOf(m.rows, 43)).toBe(HEAD_B_BRANCH_ARTIFACT_ID);
    expect(m.prCreateMany).not.toHaveBeenCalled();
  });

  it("still files a PR GitHub has not read under the desktop's head", async () => {
    const m = installPrDetailIngestDb({ branches: BRANCHES });

    await syncPrDetailRefs([prDetailRef()]);

    expect(m.prCreateMany).toHaveBeenCalledTimes(1);
    expect(branchOf(m.rows, 42)).toBe(COMMAND_BRANCH_ARTIFACT_ID);
  });
});

const HEAD_A_BRANCH_ARTIFACT_ID = "branch-artifact-github-head-a";
const HEAD_B_BRANCH_ARTIFACT_ID = "branch-artifact-github-head-b";

/** The command's one head (the harness ref's `feat/x`) plus two GitHub heads. */
const BRANCHES = [
  { artifactId: COMMAND_BRANCH_ARTIFACT_ID, branchName: "feat/x" },
  { artifactId: HEAD_A_BRANCH_ARTIFACT_ID, branchName: "feat/github-head-a" },
  { artifactId: HEAD_B_BRANCH_ARTIFACT_ID, branchName: "feat/github-head-b" },
];

/** A row a GitHub read already moved under its head (provider-read facts). */
function movedRow(number: number, branchArtifactId: string): SeededPrDetailRow {
  return {
    id: `pr-${number}`,
    branchArtifactId,
    repositoryId: "repo-1",
    repositoryFullName: "acme/web",
    number,
    fetchMechanism: GitHubFetchMechanism.Graphql,
    githubId: `gh-${number}`,
    title: `PR ${number}`,
    htmlUrl: `https://github.com/acme/web/pull/${number}`,
  };
}

/** The PR ref an older desktop build sends: no observation time, no facts. */
function installedBuildRef(prNumber: number): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.PullRequest,
    repositoryFullName: "acme/web",
    prNumber,
    method: ArtifactRefMethod.PrCreateOutput,
    relation: ArtifactRefRelation.Created,
    branchName: "feat/x",
  } as SyncedArtifactRef;
}

function branchOf(rows: SeededPrDetailRow[], number: number) {
  return rows.find((row) => row.number === number)?.branchArtifactId;
}

function branchCreates(artifactCreate: ReturnType<typeof vi.fn>) {
  return artifactCreate.mock.calls.filter(
    ([args]) =>
      (args as { data?: { type?: string } }).data?.type === ArtifactType.Branch
  );
}
