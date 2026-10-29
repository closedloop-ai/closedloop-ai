/**
 * TS-U.8: Unit tests for seed/index.ts (runSeed orchestration)
 *
 * Covers:
 *  TS-U.8  runSeed invokes all domain seed modules (seedCoreEntities,
 *          seedIntegrationEntities, seedEvaluationEntities,
 *          seedCustomizationEntities) in dependency order inside a transaction
 *
 * Module dependencies are fully mocked so no database or real seed logic runs.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomizationSeedResult } from "../../customization";

const PROFILE_AUDIT_FAILED_RE = /Profile target audit failed/;

const { customizationSeedResult } = vi.hoisted(() => {
  const result: CustomizationSeedResult = {
    textFieldId: "mock-text-field",
    numberFieldId: "mock-number-field",
    enumFieldId: "mock-enum-field",
    multiEnumFieldId: "mock-multi-enum-field",
    dateFieldId: "mock-date-field",
    peopleFieldId: "mock-people-field",
    referenceFieldId: "mock-reference-field",
    referenceMultiFieldId: "mock-reference-multi-field",
    enumOptionIds: [],
    multiEnumOptionIds: [],
  };
  return { customizationSeedResult: result };
});

// Mock all domain seed modules BEFORE importing runSeed so vi.mock() hoisting works.
vi.mock("../../core", () => ({
  seedCoreEntities: vi.fn().mockResolvedValue({
    teamId: "mock-team-id",
    projectIds: ["mock-project-0", "mock-project-1"],
    artifactIds: ["mock-artifact-0"],
    githubInstallationId: "mock-github-installation",
    githubRepositoryId: "mock-github-repository",
    branchArtifactId: "mock-branch-artifact",
  }),
}));
vi.mock("../../integrations", () => ({
  seedIntegrationEntities: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../evaluation", () => ({
  seedEvaluationEntities: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../customization", () => ({
  seedCustomizationEntities: vi.fn().mockResolvedValue(customizationSeedResult),
}));
vi.mock("../../extended", () => ({
  seedExtendedEntities: vi.fn().mockResolvedValue(undefined),
}));

import { seedCoreEntities } from "../../core";
import { seedCustomizationEntities } from "../../customization";
import { seedEvaluationEntities } from "../../evaluation";
import { seedExtendedEntities } from "../../extended";
import { runSeed } from "../../index";
import { seedIntegrationEntities } from "../../integrations";
import {
  resolveSeedRunPlan,
  SEED_PROFILES,
  SeedAuditMode,
  SeedProfileName,
} from "../../profiles";
import { baselineContext } from "../fixtures/baseline-org";
import { createMockPrisma } from "../fixtures/mock-prisma";

/**
 * Builds a mock PrismaClient with all count queries returning 1 so the
 * runSeed post-seed verification step does not throw.
 */
function buildRunSeedMock() {
  const prisma = createMockPrisma();
  const p = vi.mocked(prisma, true);

  // Every model in the summary section must have count() return >= 1.
  const countModels = [
    "team",
    "teamMember",
    "project",
    "artifact",
    "documentVersion",
    "slugCounter",
    "gitHubInstallation",
    "gitHubInstallationRepository",
    "gitHubUserConnection",
    "pullRequestDetail",
    "gitHubPRReview",
    "slackIntegration",
    "artifactEvaluation",
    "judgeScore",
    "judgeHumanScore",
    "customField",
    "customFieldEnumOption",
    "customFieldSetting",
    "customFieldValue",
    "commentThread",
    "comment",
    "commentReaction",
    "commentAttachment",
    "artifactLink",
    "artifactRating",
    "fileAttachment",
    "prompt",
  ] as const;

  for (const model of countModels) {
    p[model].count.mockResolvedValue(1);
  }
  p.project.count.mockResolvedValue(
    SEED_PROFILES[SeedProfileName.Local].projects
  );
  p.artifact.count.mockResolvedValue(
    SEED_PROFILES[SeedProfileName.Local].artifacts
  );
  p.comment.count.mockResolvedValue(
    SEED_PROFILES[SeedProfileName.Local].comments
  );

  return prisma;
}

// TS-U.8: runSeed orchestration
describe("runSeed — orchestration order (TS-U.8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish return values after clearAllMocks() resets implementations.
    vi.mocked(seedCoreEntities).mockResolvedValue({
      teamId: "mock-team-id",
      projectIds: ["mock-project-0", "mock-project-1"],
      artifactIds: ["mock-artifact-0"],
      githubInstallationId: "mock-github-installation",
      githubRepositoryId: "mock-github-repository",
      branchArtifactId: "mock-branch-artifact",
    });
    vi.mocked(seedIntegrationEntities).mockResolvedValue(undefined);
    vi.mocked(seedEvaluationEntities).mockResolvedValue(undefined);
    vi.mocked(seedCustomizationEntities).mockResolvedValue(
      customizationSeedResult
    );
  });

  it("calls seedCoreEntities inside the transaction", async () => {
    const prisma = buildRunSeedMock();
    await runSeed(prisma, baselineContext);
    expect(seedCoreEntities).toHaveBeenCalledOnce();
  });

  it("calls seedIntegrationEntities inside the transaction", async () => {
    const prisma = buildRunSeedMock();
    await runSeed(prisma, baselineContext);
    expect(seedIntegrationEntities).toHaveBeenCalledOnce();
  });

  it("calls seedEvaluationEntities inside the transaction", async () => {
    const prisma = buildRunSeedMock();
    await runSeed(prisma, baselineContext);
    expect(seedEvaluationEntities).toHaveBeenCalledOnce();
  });

  it("calls seedCustomizationEntities inside the transaction", async () => {
    const prisma = buildRunSeedMock();
    await runSeed(prisma, baselineContext);
    expect(seedCustomizationEntities).toHaveBeenCalledOnce();
  });

  it("wraps all domain calls in a single $transaction", async () => {
    const prisma = buildRunSeedMock();
    const p = vi.mocked(prisma, true);
    await runSeed(prisma, baselineContext);
    expect(p.$transaction.mock.calls.length).toBe(1);
  });

  it("passes the coreResult from seedCoreEntities to downstream modules", async () => {
    const mockCoreResult = {
      teamId: "mock-team-id",
      projectIds: ["mock-project-0", "mock-project-1"],
      artifactIds: ["mock-artifact-0"],
      githubInstallationId: "mock-github-installation",
      githubRepositoryId: "mock-github-repository",
      branchArtifactId: "mock-branch-artifact",
    };
    vi.mocked(seedCoreEntities).mockResolvedValue(mockCoreResult);

    const prisma = buildRunSeedMock();
    await runSeed(prisma, baselineContext);

    // seedIntegrationEntities receives coreResult as its third argument
    const integrationCall = vi.mocked(seedIntegrationEntities).mock.calls[0];
    expect(integrationCall[2]).toEqual(mockCoreResult);
  });

  it("passes the resolved plan to every domain module", async () => {
    const prisma = buildRunSeedMock();
    const plan = resolveSeedRunPlan({ profile: SeedProfileName.Minimal });
    const p = vi.mocked(prisma, true);
    p.project.count.mockResolvedValue(plan.targets.projects);
    p.artifact.count.mockResolvedValue(plan.targets.artifacts);
    p.comment.count.mockResolvedValue(plan.targets.comments);

    await runSeed(prisma, baselineContext, plan);

    expect(vi.mocked(seedCoreEntities).mock.calls[0][2]).toEqual(plan);
    expect(vi.mocked(seedIntegrationEntities).mock.calls[0][3]).toEqual(plan);
    expect(vi.mocked(seedEvaluationEntities).mock.calls[0][3]).toEqual(plan);
    expect(vi.mocked(seedCustomizationEntities).mock.calls[0][3]).toEqual(plan);
  });

  it("runs perf profile seeding without wrapping all modules in one transaction", async () => {
    const prisma = buildRunSeedMock();
    const p = vi.mocked(prisma, true);
    const plan = resolveSeedRunPlan({ profile: SeedProfileName.Perf });
    p.project.count.mockResolvedValue(plan.targets.projects);
    p.artifact.count.mockResolvedValue(plan.targets.artifacts);
    p.comment.count.mockResolvedValue(plan.targets.comments);

    await runSeed(prisma, baselineContext, plan);

    expect(p.$transaction).not.toHaveBeenCalled();
    expect(
      vi.mocked(seedCoreEntities).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(seedIntegrationEntities).mock.invocationCallOrder[0]
    );
    expect(
      vi.mocked(seedCustomizationEntities).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(seedExtendedEntities).mock.invocationCallOrder[0]);
  });

  it("treats out-of-range counts as informational for IdempotentSeedOrg reruns", async () => {
    const prisma = buildRunSeedMock();
    const p = vi.mocked(prisma, true);
    // Simulate rerunning the minimal profile against an org that still holds
    // local-profile-sized rows from a previous seed: counts are far above
    // minimal targetRanges, which would throw under CleanOrg but must be
    // informational under IdempotentSeedOrg.
    p.project.count.mockResolvedValue(
      SEED_PROFILES[SeedProfileName.Local].projects
    );
    p.artifact.count.mockResolvedValue(
      SEED_PROFILES[SeedProfileName.Local].artifacts
    );
    p.comment.count.mockResolvedValue(
      SEED_PROFILES[SeedProfileName.Local].comments
    );
    const plan = resolveSeedRunPlan({
      profile: SeedProfileName.Minimal,
      auditMode: SeedAuditMode.IdempotentSeedOrg,
    });

    await expect(
      runSeed(prisma, baselineContext, plan)
    ).resolves.toBeUndefined();
  });

  it("throws on out-of-range counts under CleanOrg audit mode", async () => {
    const prisma = buildRunSeedMock();
    const p = vi.mocked(prisma, true);
    p.project.count.mockResolvedValue(
      SEED_PROFILES[SeedProfileName.Local].projects
    );
    p.artifact.count.mockResolvedValue(
      SEED_PROFILES[SeedProfileName.Local].artifacts
    );
    p.comment.count.mockResolvedValue(
      SEED_PROFILES[SeedProfileName.Local].comments
    );
    const plan = resolveSeedRunPlan({
      profile: SeedProfileName.Minimal,
      auditMode: SeedAuditMode.CleanOrg,
    });

    await expect(runSeed(prisma, baselineContext, plan)).rejects.toThrow(
      PROFILE_AUDIT_FAILED_RE
    );
  });

  it("throws when organizationId is missing from context", async () => {
    const prisma = buildRunSeedMock();
    const badContext = { organizationId: "", userId: "some-user" };
    await expect(runSeed(prisma, badContext)).rejects.toThrow(
      "organizationId is required"
    );
  });

  it("throws when userId is missing from context", async () => {
    const prisma = buildRunSeedMock();
    const badContext = { organizationId: "some-org", userId: "" };
    await expect(runSeed(prisma, badContext)).rejects.toThrow(
      "userId is required"
    );
  });
});
