/**
 * Unit tests for seed/non-empty-org-guard.ts (detectOrgConflicts)
 *
 * Covers:
 *   (1) Guard aborts when any integration/entity conflict is detected and
 *       SEED_FORCE_OVERWRITE is unset — verified by asserting that
 *       detectOrgConflicts returns a non-empty conflicts array (the seed.ts
 *       caller calls process.exit when conflicts.length > 0 and the env var
 *       is absent).
 *   (2) Guard proceeds with a warning when conflicts exist and
 *       SEED_FORCE_OVERWRITE=1 — verified by asserting detectOrgConflicts
 *       returns the same non-empty conflicts array regardless of the env var
 *       (the env-var check lives in seed.ts, not in detectOrgConflicts).
 *   (3) Guard passes through cleanly when the org has no existing data —
 *       detectOrgConflicts returns an empty conflicts array.
 *   (4) Individual conflict detection for each of the 5 checked models:
 *       GitHubInstallation, LinearIntegration, SlackIntegration,
 *       Project, Team.
 *
 * All Prisma calls are mocked; no database connection is required.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deterministicUuid } from "../../helpers";
import {
  detectOrgConflicts,
  SeedOrgPreflightStatus,
} from "../../non-empty-org-guard";
import { BASELINE_ORG_ID } from "../fixtures/baseline-org";
import { createMockPrisma } from "../fixtures/mock-prisma";

// Shorthand to access mock call records without fighting Prisma's fluent types.
type AnyDelegate = any;

/**
 * Builds a mock PrismaClient where no integrations exist and all
 * entity counts are zero — representing a clean, empty org.
 */
function buildEmptyOrgMock() {
  const prisma = createMockPrisma();
  const p = prisma as AnyDelegate;

  // No integrations
  p.gitHubInstallation.findUnique.mockResolvedValue(null);
  p.linearIntegration.findUnique.mockResolvedValue(null);
  p.slackIntegration.findUnique.mockResolvedValue(null);

  // No entity rows
  p.project.count.mockResolvedValue(0);
  p.team.count.mockResolvedValue(0);

  return prisma;
}

/**
 * Builds a mock PrismaClient where all 6 models have pre-existing data —
 * representing a fully non-empty org.
 */
function buildFullyConflictedOrgMock() {
  const prisma = createMockPrisma();
  const p = prisma as AnyDelegate;

  p.gitHubInstallation.findUnique.mockResolvedValue({ id: "gh-install-1" });
  p.linearIntegration.findUnique.mockResolvedValue({ id: "linear-1" });
  p.slackIntegration.findUnique.mockResolvedValue({ id: "slack-1" });
  p.project.count.mockResolvedValue(3);
  p.team.count.mockResolvedValue(2);

  return prisma;
}

function buildSeedOwnedOrgMock() {
  const prisma = createMockPrisma();
  const p = prisma as AnyDelegate;

  p.gitHubInstallation.findUnique.mockResolvedValue({
    id: deterministicUuid(`github-installation:${BASELINE_ORG_ID}:seed`),
  });
  p.linearIntegration.findUnique.mockResolvedValue({
    id: deterministicUuid(`linear-integration:${BASELINE_ORG_ID}:seed`),
  });
  p.slackIntegration.findUnique.mockResolvedValue({
    id: deterministicUuid(`slack-integration:${BASELINE_ORG_ID}:seed`),
  });
  p.project.count.mockResolvedValue(2);
  p.project.findMany.mockResolvedValue([
    {
      id: deterministicUuid(`project:${BASELINE_ORG_ID}:platform-foundation`),
      slug: "platform-foundation",
    },
    {
      id: deterministicUuid(`project:${BASELINE_ORG_ID}:developer-experience`),
      slug: "developer-experience",
    },
  ]);
  p.team.count.mockResolvedValue(1);
  p.team.findMany.mockResolvedValue([
    {
      id: deterministicUuid(`team:${BASELINE_ORG_ID}:default`),
      slug: "default",
    },
  ]);
  p.artifact.count.mockResolvedValue(4);
  p.artifact.findMany.mockResolvedValue([
    {
      id: deterministicUuid(`artifact:document:${BASELINE_ORG_ID}:prd`),
      slug: "seed-doc-prd-001",
    },
    {
      id: deterministicUuid(
        `artifact:branch:${BASELINE_ORG_ID}:seed-feature-branch`
      ),
      slug: `seed-branch-${BASELINE_ORG_ID.slice(0, 8)}`,
    },
    {
      id: deterministicUuid(
        `artifact:deployment:${BASELINE_ORG_ID}:seed-preview`
      ),
      slug: `seed-deployment-${BASELINE_ORG_ID.slice(0, 8)}`,
    },
    {
      id: deterministicUuid(`artifact:session:${BASELINE_ORG_ID}:seed-session`),
      slug: `seed-session-${BASELINE_ORG_ID.slice(0, 8)}`,
    },
  ]);
  p.loop.count.mockResolvedValue(1);
  p.loop.findMany.mockResolvedValue([
    {
      id: deterministicUuid(`loop:${BASELINE_ORG_ID}:plan-generation`),
      prompt: "Generate an implementation plan for the seed workstream",
    },
  ]);
  p.comment.count.mockResolvedValue(5);
  p.comment.findMany.mockResolvedValue([
    {
      id: deterministicUuid(`comment:${BASELINE_ORG_ID}:seed`),
      plainText: "Seed baseline comment",
    },
    {
      id: deterministicUuid(`comment:${BASELINE_ORG_ID}:native`),
      plainText: "Initial feedback on this document.",
    },
    {
      id: deterministicUuid(`comment:${BASELINE_ORG_ID}:native-reply`),
      plainText: "Follow-up: looks good after review.",
    },
    {
      id: deterministicUuid(`comment:${BASELINE_ORG_ID}:liveblocks`),
      plainText: "Liveblocks collaborative comment.",
    },
    {
      id: deterministicUuid(`comment:${BASELINE_ORG_ID}:github`),
      plainText:
        "GitHub PR review comment — please address the naming convention.",
    },
  ]);
  p.customField.count.mockResolvedValue(1);
  p.customField.findMany.mockResolvedValue([
    {
      id: deterministicUuid(`custom-field:${BASELINE_ORG_ID}:notes`),
      name: "Notes",
    },
  ]);
  p.artifactEvaluation.count.mockResolvedValue(1);
  p.artifactEvaluation.findMany.mockResolvedValue([
    {
      id: deterministicUuid(`artifact-evaluation:${BASELINE_ORG_ID}:plan`),
      reportId: `seed-report-plan-${BASELINE_ORG_ID}`,
    },
  ]);

  return prisma;
}

// ---------------------------------------------------------------------------
// Suite: clean org → no conflicts
// ---------------------------------------------------------------------------

describe("detectOrgConflicts — clean org (no existing data)", () => {
  it("returns an empty conflicts array when no integrations or entities exist", async () => {
    const prisma = buildEmptyOrgMock();
    const result = await detectOrgConflicts(prisma, BASELINE_ORG_ID);
    expect(result.conflicts).toHaveLength(0);
    expect(result.seedOwnedRows).toHaveLength(0);
    expect(result.status).toBe(SeedOrgPreflightStatus.Clean);
  });

  it("passes organizationId to all 6 model queries", async () => {
    const prisma = buildEmptyOrgMock();
    const p = prisma as AnyDelegate;

    await detectOrgConflicts(prisma, BASELINE_ORG_ID);

    expect(p.gitHubInstallation.findUnique).toHaveBeenCalledWith({
      where: { organizationId: BASELINE_ORG_ID },
      select: { id: true },
    });
    expect(p.linearIntegration.findUnique).toHaveBeenCalledWith({
      where: { organizationId: BASELINE_ORG_ID },
      select: { id: true },
    });
    expect(p.slackIntegration.findUnique).toHaveBeenCalledWith({
      where: { organizationId: BASELINE_ORG_ID },
      select: { id: true },
    });
    expect(p.project.count).toHaveBeenCalledWith({
      where: { organizationId: BASELINE_ORG_ID },
    });
    expect(p.team.count).toHaveBeenCalledWith({
      where: { organizationId: BASELINE_ORG_ID },
    });
    expect(p.loop.findMany).toHaveBeenCalledWith({
      where: { organizationId: BASELINE_ORG_ID },
      select: { id: true, prompt: true },
      take: 500,
    });
    expect(p.comment.findMany).toHaveBeenCalledWith({
      where: { thread: { organizationId: BASELINE_ORG_ID } },
      select: { id: true, plainText: true },
      take: 500,
    });
  });
});

describe("detectOrgConflicts — seed-owned idempotent org", () => {
  it("classifies deterministic seed rows as idempotent instead of conflicts", async () => {
    const prisma = buildSeedOwnedOrgMock();
    const result = await detectOrgConflicts(prisma, BASELINE_ORG_ID);

    expect(result.conflicts).toHaveLength(0);
    expect(result.seedOwnedRows).toEqual([
      "GitHubInstallation (seed-owned)",
      "LinearIntegration (seed-owned)",
      "SlackIntegration (seed-owned)",
      "Project (2 rows)",
      "Team (1 row)",
      "Artifact (4 rows)",
      "Loop (1 row)",
      "Comment (5 rows)",
      "CustomField (1 row)",
      "ArtifactEvaluation (1 row)",
    ]);
    expect(result.status).toBe(SeedOrgPreflightStatus.SeedOwned);
  });

  it("fails closed when seed-owned rows are mixed with a foreign row", async () => {
    const prisma = buildSeedOwnedOrgMock();
    const p = prisma as AnyDelegate;
    p.project.findMany.mockResolvedValue([
      {
        id: deterministicUuid(`project:${BASELINE_ORG_ID}:platform-foundation`),
        slug: "platform-foundation",
      },
      { id: "foreign-project-id", slug: "customer-project" },
    ]);

    const result = await detectOrgConflicts(prisma, BASELINE_ORG_ID);

    expect(result.conflicts).toContain("Project (2 rows)");
    expect(result.status).toBe(SeedOrgPreflightStatus.Conflicted);
  });

  it("fails closed when a foreign artifact is mixed into a seed-owned org", async () => {
    const prisma = buildSeedOwnedOrgMock();
    const p = prisma as AnyDelegate;
    p.artifact.count.mockResolvedValue(2);
    p.artifact.findMany.mockResolvedValue([
      {
        id: deterministicUuid(`artifact:document:${BASELINE_ORG_ID}:prd`),
        slug: "seed-doc-prd-001",
      },
      { id: "foreign-artifact-id", slug: "customer-artifact" },
    ]);

    const result = await detectOrgConflicts(prisma, BASELINE_ORG_ID);

    expect(result.conflicts).toContain("Artifact (2 rows)");
    expect(result.status).toBe(SeedOrgPreflightStatus.Conflicted);
  });

  it("fails closed when bounded seed-owned sampling cannot prove every artifact row", async () => {
    const prisma = buildSeedOwnedOrgMock();
    const p = prisma as AnyDelegate;
    p.artifact.count.mockResolvedValue(501);
    p.artifact.findMany.mockResolvedValue([
      {
        id: deterministicUuid(`artifact:document:${BASELINE_ORG_ID}:prd`),
        slug: "seed-doc-prd-001",
      },
    ]);

    const result = await detectOrgConflicts(prisma, BASELINE_ORG_ID);

    expect(p.artifact.findMany).toHaveBeenCalledWith({
      where: { organizationId: BASELINE_ORG_ID },
      select: { id: true, slug: true },
      take: 500,
    });
    expect(result.conflicts).toContain("Artifact (501 rows)");
    expect(result.status).toBe(SeedOrgPreflightStatus.Conflicted);
  });
});

// ---------------------------------------------------------------------------
// Suite: non-empty org → conflicts detected, no SEED_FORCE_OVERWRITE
// ---------------------------------------------------------------------------

describe("detectOrgConflicts — non-empty org without SEED_FORCE_OVERWRITE", () => {
  beforeEach(() => {
    // Ensure the env var is unset for these tests
    delete process.env.SEED_FORCE_OVERWRITE;
  });

  it("returns a non-empty conflicts array when all 6 models have data", async () => {
    const prisma = buildFullyConflictedOrgMock();
    const result = await detectOrgConflicts(prisma, BASELINE_ORG_ID);
    expect(result.conflicts.length).toBeGreaterThan(0);
  });

  it("includes all 6 conflict descriptions when all models are populated", async () => {
    const prisma = buildFullyConflictedOrgMock();
    const { conflicts } = await detectOrgConflicts(prisma, BASELINE_ORG_ID);

    expect(conflicts).toContain("GitHubInstallation (one per org)");
    expect(conflicts).toContain("LinearIntegration (one per org)");
    expect(conflicts).toContain("SlackIntegration (one per org)");
    // Project/Team include the row count
    expect(conflicts.some((c) => c.startsWith("Project ("))).toBe(true);
    expect(conflicts.some((c) => c.startsWith("Team ("))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite: non-empty org WITH SEED_FORCE_OVERWRITE=1 — same conflicts returned
// ---------------------------------------------------------------------------

describe("detectOrgConflicts — non-empty org WITH SEED_FORCE_OVERWRITE=1", () => {
  beforeEach(() => {
    process.env.SEED_FORCE_OVERWRITE = "1";
  });

  afterEach(() => {
    delete process.env.SEED_FORCE_OVERWRITE;
  });

  it("still returns the non-empty conflicts array (env-var handling is in caller)", async () => {
    const prisma = buildFullyConflictedOrgMock();
    const { conflicts } = await detectOrgConflicts(prisma, BASELINE_ORG_ID);
    // detectOrgConflicts is a pure detection function; SEED_FORCE_OVERWRITE
    // does not suppress the conflict list — seed.ts decides what to do with it.
    expect(conflicts.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Suite: individual conflict detection — one model at a time
// ---------------------------------------------------------------------------

describe("detectOrgConflicts — individual model conflict detection", () => {
  it("detects only GitHubInstallation when it is the sole conflict", async () => {
    const prisma = buildEmptyOrgMock();
    const p = prisma as AnyDelegate;
    p.gitHubInstallation.findUnique.mockResolvedValue({ id: "gh-install-1" });

    const { conflicts } = await detectOrgConflicts(prisma, BASELINE_ORG_ID);

    expect(conflicts).toEqual(["GitHubInstallation (one per org)"]);
  });

  it("detects only LinearIntegration when it is the sole conflict", async () => {
    const prisma = buildEmptyOrgMock();
    const p = prisma as AnyDelegate;
    p.linearIntegration.findUnique.mockResolvedValue({ id: "linear-1" });

    const { conflicts } = await detectOrgConflicts(prisma, BASELINE_ORG_ID);

    expect(conflicts).toEqual(["LinearIntegration (one per org)"]);
  });

  it("detects only SlackIntegration when it is the sole conflict", async () => {
    const prisma = buildEmptyOrgMock();
    const p = prisma as AnyDelegate;
    p.slackIntegration.findUnique.mockResolvedValue({ id: "slack-1" });

    const { conflicts } = await detectOrgConflicts(prisma, BASELINE_ORG_ID);

    expect(conflicts).toEqual(["SlackIntegration (one per org)"]);
  });

  it("detects only Project rows when they are the sole conflict", async () => {
    const prisma = buildEmptyOrgMock();
    const p = prisma as AnyDelegate;
    p.project.count.mockResolvedValue(2);

    const { conflicts } = await detectOrgConflicts(prisma, BASELINE_ORG_ID);

    expect(conflicts).toEqual(["Project (2 rows)"]);
  });

  it("detects only Team rows when they are the sole conflict", async () => {
    const prisma = buildEmptyOrgMock();
    const p = prisma as AnyDelegate;
    p.team.count.mockResolvedValue(1);

    const { conflicts } = await detectOrgConflicts(prisma, BASELINE_ORG_ID);

    expect(conflicts).toEqual(["Team (1 row)"]);
  });

  it("conflict descriptions include the actual row count for Project", async () => {
    const prisma = buildEmptyOrgMock();
    const p = prisma as AnyDelegate;
    p.project.count.mockResolvedValue(7);

    const { conflicts } = await detectOrgConflicts(prisma, BASELINE_ORG_ID);

    expect(conflicts).toContain("Project (7 rows)");
  });

  it("conflict descriptions include the actual row count for Team", async () => {
    const prisma = buildEmptyOrgMock();
    const p = prisma as AnyDelegate;
    p.team.count.mockResolvedValue(3);

    const { conflicts } = await detectOrgConflicts(prisma, BASELINE_ORG_ID);

    expect(conflicts).toContain("Team (3 rows)");
  });
});

// ---------------------------------------------------------------------------
// Suite: conflict ordering
// ---------------------------------------------------------------------------

describe("detectOrgConflicts — conflict list ordering", () => {
  it("lists conflicts in the canonical order: GitHub, Linear, Slack, Project, Team", async () => {
    const prisma = buildFullyConflictedOrgMock();
    const { conflicts } = await detectOrgConflicts(prisma, BASELINE_ORG_ID);

    expect(conflicts[0]).toBe("GitHubInstallation (one per org)");
    expect(conflicts[1]).toBe("LinearIntegration (one per org)");
    expect(conflicts[2]).toBe("SlackIntegration (one per org)");
    expect(conflicts[3]?.startsWith("Project (")).toBe(true);
    expect(conflicts[4]?.startsWith("Team (")).toBe(true);
  });
});
