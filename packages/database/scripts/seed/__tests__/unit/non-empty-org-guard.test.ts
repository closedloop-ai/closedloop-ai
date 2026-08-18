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
import {
  type AnyDelegate,
  buildEmptyOrgMock,
  buildFullyConflictedOrgMock,
  buildSeedOwnedOrgMock,
} from "../fixtures/org-guard-mocks";

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
      // No LinearIntegration entry: the seed never creates one, so a seeded
      // org has no such row for the guard to recognise.
      "GitHubInstallation (seed-owned)",
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
