import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../../../generated/client";
import { SeedProfileName } from "../../profiles";
import {
  countResettableOrgRows,
  formatResetSummary,
  ResetDeleteError,
  type ResetScope,
  type ResetVerificationSnapshot,
  resetOrgData,
  SeedResetFailureReason,
  verifyResetComplete,
} from "../../reset";
import { BASELINE_ORG_ID } from "../fixtures/baseline-org";
import { createMockPrisma } from "../fixtures/mock-prisma";

const EMPTY_SCOPE: ResetScope = {
  projectIds: [],
  teamIds: [],
  artifactIds: [],
  documentDetailIds: [],
  branchArtifactIds: [],
  pullRequestDetailIds: [],
  loopIds: [],
  computeTargetIds: [],
  desktopCommandIds: [],
  agentSessionIds: [],
  customFieldIds: [],
  customFieldEnumOptionIds: [],
  tagIds: [],
  githubInstallationIds: [],
  githubRepositoryIds: [],
  agentIds: [],
  catalogItemIds: [],
};

describe("reset helpers", () => {
  it("counts org-scoped LinearSubtask rows during reset verification", async () => {
    const prisma = createMockPrisma();
    const p = vi.mocked(prisma, true);
    const snapshot = buildSnapshot({});
    p.linearSubtask.count.mockResolvedValue(2);

    const summary = await countResettableOrgRows(
      prisma,
      BASELINE_ORG_ID,
      snapshot
    );

    expect(p.linearSubtask.count).toHaveBeenCalledWith({
      where: { organizationId: BASELINE_ORG_ID },
    });
    expect(summary.modelCounts).toContainEqual({
      name: "LinearSubtask",
      count: 2,
    });
  });

  it("verifies remaining org-scoped rows even when current snapshot scope is empty", async () => {
    const prisma = createMockPrisma();
    const p = vi.mocked(prisma, true);
    const snapshot = buildSnapshot({});
    p.linearSubtask.count.mockResolvedValue(1);

    const verification = await verifyResetComplete(
      prisma,
      BASELINE_ORG_ID,
      snapshot
    );

    expect(verification).toEqual({
      ok: false,
      remaining: [{ name: "LinearSubtask", count: 1 }],
    });
  });

  it("leaves preserved user and org rows untouched and does not touch excluded global tables", async () => {
    const prisma = createMockPrisma();
    const p = vi.mocked(prisma, true);
    stubDeleteManyCounts(prisma);

    await resetOrgData(prisma, BASELINE_ORG_ID);

    // ISS-12435: the Claude key and preferred compute target columns this reset
    // used to clear are `@ignore`d (the data step nulls them), so reset no longer
    // writes the preserved user and organization rows at all.
    expect(p.user.updateMany).not.toHaveBeenCalled();
    expect(p.organization.update).not.toHaveBeenCalled();
    expect(p.oAuthRevokedToken.deleteMany).not.toHaveBeenCalled();
    expect(p.oAuthRateLimit.deleteMany).not.toHaveBeenCalled();
    expect(p.localGatewayChallengeJti.deleteMany).not.toHaveBeenCalled();
    expect(p.previewSchema.deleteMany).not.toHaveBeenCalled();
    expect(p.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 300_000,
      maxWait: 10_000,
    });
  });

  it("uses batched profile strategy for perf reset instead of one wide transaction", async () => {
    const prisma = createMockPrisma();
    const p = vi.mocked(prisma, true);
    stubDeleteManyCounts(prisma);

    await resetOrgData(prisma, BASELINE_ORG_ID, SeedProfileName.Perf);

    expect(p.$transaction).not.toHaveBeenCalled();
    expect(p.project.deleteMany).toHaveBeenCalledWith({
      where: { organizationId: BASELINE_ORG_ID },
    });
  });

  it("keeps reset delete and verification model lists in sync", async () => {
    const prisma = createMockPrisma();
    stubDeleteManyCounts(prisma);
    const snapshot = buildSnapshot({});

    const deleteSummary = await resetOrgData(prisma, BASELINE_ORG_ID);
    const verificationSummary = await countResettableOrgRows(
      prisma,
      BASELINE_ORG_ID,
      snapshot
    );

    expect(deleteSummary.modelCounts.map(({ name }) => name).sort()).toEqual(
      verificationSummary.modelCounts.map(({ name }) => name).sort()
    );
  });

  it("labels reset delete failures with the failing model and reason", async () => {
    const prisma = createMockPrisma();
    const p = vi.mocked(prisma, true);
    stubDeleteManyCounts(prisma);
    p.comment.deleteMany.mockRejectedValue(new Error("delete failed"));

    await expect(resetOrgData(prisma, BASELINE_ORG_ID)).rejects.toMatchObject({
      modelName: "Comment",
      reason: SeedResetFailureReason.ResetDeleteFailed,
    });
    await expect(resetOrgData(prisma, BASELINE_ORG_ID)).rejects.toBeInstanceOf(
      ResetDeleteError
    );
  });

  it("scopes comment-subtree deletes via relation predicates instead of materialized id lists", async () => {
    const prisma = createMockPrisma();
    const p = vi.mocked(prisma, true);
    stubDeleteManyCounts(prisma);

    await resetOrgData(prisma, BASELINE_ORG_ID);

    expect(p.comment.deleteMany).toHaveBeenCalledWith({
      where: { thread: { organizationId: BASELINE_ORG_ID } },
    });
    expect(p.commentReaction.deleteMany).toHaveBeenCalledWith({
      where: { comment: { thread: { organizationId: BASELINE_ORG_ID } } },
    });
    expect(p.commentAttachment.deleteMany).toHaveBeenCalledWith({
      where: { comment: { thread: { organizationId: BASELINE_ORG_ID } } },
    });
    expect(p.gitHubCommentProjection.deleteMany).toHaveBeenCalledWith({
      where: {
        threadProjection: { thread: { organizationId: BASELINE_ORG_ID } },
      },
    });
    expect(p.gitHubCommentThreadProjection.deleteMany).toHaveBeenCalledWith({
      where: { thread: { organizationId: BASELINE_ORG_ID } },
    });
  });

  it("does not materialize per-comment ids before delete or count", async () => {
    const prisma = createMockPrisma();
    const p = vi.mocked(prisma, true);
    stubDeleteManyCounts(prisma);

    await resetOrgData(prisma, BASELINE_ORG_ID);

    // commentIds materialization across the org would call comment.findMany
    // with a threadId IN (...) predicate. With relation predicates this call
    // must not happen, which is what protects perf-scale resets from blowing
    // past the Postgres bind-parameter limit.
    expect(p.comment.findMany).not.toHaveBeenCalled();
    expect(p.commentThread.findMany).not.toHaveBeenCalled();
  });

  it("explicitly deletes and counts BranchStatusCheck rows", async () => {
    const prisma = createMockPrisma();
    const p = vi.mocked(prisma, true);
    stubDeleteManyCounts(prisma);
    const snapshot = buildSnapshot({
      branchArtifactIds: ["00000000-0000-4000-8000-0000000000bc"],
    });

    const summary = await resetOrgData(prisma, BASELINE_ORG_ID);
    expect(p.branchStatusCheck.deleteMany).toHaveBeenCalledWith({
      where: { branchArtifactId: { in: [] } },
    });
    expect(summary.modelCounts.map(({ name }) => name)).toContain(
      "BranchStatusCheck"
    );

    p.branchStatusCheck.count.mockResolvedValue(2);
    const verification = await countResettableOrgRows(
      prisma,
      BASELINE_ORG_ID,
      snapshot
    );
    expect(p.branchStatusCheck.count).toHaveBeenCalledWith({
      where: { branchArtifactId: { in: snapshot.scope.branchArtifactIds } },
    });
    expect(verification.modelCounts).toContainEqual({
      name: "BranchStatusCheck",
      count: 2,
    });
  });

  it("formats model counts without target names, emails, credentials, or tokens", () => {
    const lines = formatResetSummary({
      modelCounts: [{ name: "Project", count: 3 }],
      totalRows: 3,
    });

    expect(lines).toEqual([
      "[seed] Reset summary:",
      "[seed]   Project                              3",
      "[seed]   Total                                3",
    ]);
  });
});

function buildSnapshot(scope: Partial<ResetScope>): ResetVerificationSnapshot {
  return {
    organizationId: BASELINE_ORG_ID,
    scope: { ...EMPTY_SCOPE, ...scope },
  };
}

function stubDeleteManyCounts(prisma: PrismaClient): void {
  const delegates: unknown[] = Object.values(prisma);
  for (const delegate of delegates) {
    if (
      delegate &&
      typeof delegate === "object" &&
      "deleteMany" in delegate &&
      vi.isMockFunction(delegate.deleteMany)
    ) {
      delegate.deleteMany.mockResolvedValue({ count: 0 });
    }
  }
}
