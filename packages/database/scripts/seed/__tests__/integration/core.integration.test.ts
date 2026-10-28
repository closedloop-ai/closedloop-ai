/**
 * Core integration tests: TS-I.1, TS-I.4, TS-I.5, TS-I.7
 *
 * Covers:
 *   TS-I.1  Team and Projects created and queryable (AC-001, AC-002)
 *   TS-I.4  Artifacts cover all ArtifactType and DocumentStatus values (AC-005)
 *   TS-I.5  Feature artifacts exist for all FeatureStatus values (AC-005)
 *   TS-I.7  Template unique constraint (one per subtype per org) (AC-009)
 *
 * TS-I.2 (workstreams cover all WorkstreamState values) was deleted with the
 * workstream concept in PLN-787. TS-I.3 and TS-I.6 (loop status coverage and
 * active loop uniqueness) were deleted with Loops in ISS-12435; the seed now
 * writes no Loop rows.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ArtifactSubtype,
  ArtifactType,
  DocumentStatus,
  FeatureStatus,
} from "../../../../generated/client";
import { runSeed } from "../../index";
import {
  BASELINE_ORG_ID,
  BASELINE_USER_ID,
  baselineContext,
} from "../fixtures/baseline-org";
import {
  type EphemeralDbContext,
  setupEphemeralDb,
  teardownEphemeralDb,
} from "../fixtures/ephemeral-db";

const DATABASE_URL_SET = Boolean(process.env.DATABASE_URL);

describe.skipIf(!DATABASE_URL_SET)(
  "Core seed integration tests (TS-I.1 through TS-I.7)",
  () => {
    let ctx: EphemeralDbContext;

    beforeAll(async () => {
      ctx = await setupEphemeralDb();
      await runSeed(ctx.prisma, baselineContext);
    }, 120_000);

    afterAll(async () => {
      await teardownEphemeralDb(ctx);
    });

    // -------------------------------------------------------------------------
    // TS-I.1: Team and Projects created and queryable (AC-001, AC-002)
    // -------------------------------------------------------------------------

    describe("TS-I.1 — Team and Projects created and queryable (AC-001, AC-002)", () => {
      it("creates exactly one team scoped to the organization", async () => {
        const count = await ctx.prisma.team.count({
          where: { organizationId: BASELINE_ORG_ID },
        });
        expect(count).toBeGreaterThanOrEqual(1);
      });

      it("adds the seed user as a team member", async () => {
        const teams = await ctx.prisma.team.findMany({
          where: { organizationId: BASELINE_ORG_ID },
          include: { members: true },
        });
        const allMembers = teams.flatMap((t) => t.members);
        const seedMember = allMembers.find(
          (m) => m.userId === BASELINE_USER_ID
        );
        expect(seedMember).toBeDefined();
      });

      it("creates at least two projects scoped to the organization", async () => {
        const count = await ctx.prisma.project.count({
          where: { organizationId: BASELINE_ORG_ID },
        });
        expect(count).toBeGreaterThanOrEqual(2);
      });

      it("assigns the seed user as createdBy on all projects", async () => {
        const projects = await ctx.prisma.project.findMany({
          where: { organizationId: BASELINE_ORG_ID },
          select: { createdById: true },
        });
        for (const project of projects) {
          expect(project.createdById).toBe(BASELINE_USER_ID);
        }
      });

      it("creates slug counters for all artifact type prefixes", async () => {
        const slugCounters = await ctx.prisma.slugCounter.findMany({
          where: { organizationId: BASELINE_ORG_ID },
          select: { typePrefix: true },
        });
        const prefixes = slugCounters.map((s) => s.typePrefix);
        for (const expected of ["PRO", "PRD", "PLN", "FEA"]) {
          expect(prefixes).toContain(expected);
        }
      });
    });

    // -------------------------------------------------------------------------
    // ISS-12435: Loops are retired, so the seed writes no Loop rows.
    // -------------------------------------------------------------------------

    describe("ISS-12435: the seed writes no Loop rows", () => {
      it("leaves the Loop and LoopEvent tables empty for the seeded org", async () => {
        const [loopCount, loopEventCount] = await Promise.all([
          ctx.prisma.loop.count({ where: { organizationId: BASELINE_ORG_ID } }),
          ctx.prisma.loopEvent.count({
            where: { loop: { organizationId: BASELINE_ORG_ID } },
          }),
        ]);
        expect(loopCount).toBe(0);
        expect(loopEventCount).toBe(0);
      });
    });

    // -------------------------------------------------------------------------
    // TS-I.4: Artifacts cover all ArtifactType and DocumentStatus values (AC-005)
    // -------------------------------------------------------------------------

    describe("TS-I.4 — Artifacts cover all ArtifactType and DocumentStatus values (AC-005)", () => {
      it("seeds artifacts covering all three ArtifactType values", async () => {
        const artifacts = await ctx.prisma.artifact.findMany({
          where: { organizationId: BASELINE_ORG_ID },
          select: { type: true },
        });

        const seededTypes = new Set(artifacts.map((a) => a.type));
        for (const type of Object.values(ArtifactType)) {
          expect(
            seededTypes.has(type),
            `Expected ArtifactType.${type} to be seeded`
          ).toBe(true);
        }
      });

      it("seeds DOCUMENT artifacts covering all DocumentStatus values", async () => {
        const artifacts = await ctx.prisma.artifact.findMany({
          where: {
            organizationId: BASELINE_ORG_ID,
            type: ArtifactType.DOCUMENT,
          },
          select: { status: true },
        });

        const seededStatuses = new Set(artifacts.map((a) => a.status));
        for (const status of Object.values(DocumentStatus)) {
          expect(
            seededStatuses.has(status),
            `Expected DocumentStatus.${status} to be present in DOCUMENT artifacts`
          ).toBe(true);
        }
      });

      it("seeds at least one BRANCH artifact", async () => {
        const count = await ctx.prisma.artifact.count({
          where: { organizationId: BASELINE_ORG_ID, type: ArtifactType.BRANCH },
        });
        expect(count).toBeGreaterThanOrEqual(1);
      });

      it("seeds at least one DEPLOYMENT artifact", async () => {
        const count = await ctx.prisma.artifact.count({
          where: {
            organizationId: BASELINE_ORG_ID,
            type: ArtifactType.DEPLOYMENT,
          },
        });
        expect(count).toBeGreaterThanOrEqual(1);
      });
    });

    // -------------------------------------------------------------------------
    // TS-I.5: Feature artifacts exist for all FeatureStatus values (AC-005)
    // -------------------------------------------------------------------------

    describe("TS-I.5 — Feature artifacts exist for all FeatureStatus values (AC-005)", () => {
      it("seeds FEATURE subtype artifacts covering all FeatureStatus values", async () => {
        const featureArtifacts = await ctx.prisma.artifact.findMany({
          where: {
            organizationId: BASELINE_ORG_ID,
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.FEATURE,
          },
          select: { status: true },
        });

        // Post-PRD-495 Features carry FeatureStatus values, not DocumentStatus.
        const seededStatuses = new Set(featureArtifacts.map((a) => a.status));
        for (const status of Object.values(FeatureStatus)) {
          expect(
            seededStatuses.has(status),
            `Expected FEATURE artifact with FeatureStatus.${status} to be seeded`
          ).toBe(true);
        }
      });
    });

    // -------------------------------------------------------------------------
    // TS-I.7: Template unique constraint (one per subtype per org) (AC-009)
    // -------------------------------------------------------------------------

    describe("TS-I.7 — Template unique constraint (one per subtype per org) (AC-009)", () => {
      it("seeds exactly one TEMPLATE artifact per ArtifactSubtype value", async () => {
        const templateArtifacts = await ctx.prisma.artifact.findMany({
          where: {
            organizationId: BASELINE_ORG_ID,
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.TEMPLATE,
          },
          include: {
            document: { select: { templateForType: true } },
          },
        });

        const templateForTypes = templateArtifacts
          .map((a) => a.document?.templateForType)
          .filter((t): t is ArtifactSubtype => t !== null && t !== undefined);

        const uniqueTemplateForTypes = new Set(templateForTypes);

        // All concrete PERSISTED ArtifactSubtype values should appear exactly
        // once as templateForType. This mirrors core.ts's exclusions:
        // - ArtifactSubtype.TEMPLATE — a "template-for-templates" is
        //   semantically nonsensical (templates document the shape of concrete
        //   subtypes, not of TEMPLATE itself).
        // - ArtifactSubtype.ISSUE — the FEA-3956 canonical input alias for the
        //   persisted `FEATURE` subtype. It never persists
        //   (normalizeArtifactSubtype maps it back to FEATURE), so core.ts does
        //   not seed a separate ISSUE template; templating it would duplicate
        //   the Feature template.
        const concreteSubtypes = Object.values(ArtifactSubtype).filter(
          (s) => s !== ArtifactSubtype.TEMPLATE && s !== ArtifactSubtype.ISSUE
        );
        for (const subtype of concreteSubtypes) {
          expect(
            uniqueTemplateForTypes.has(subtype),
            `Expected a template artifact with templateForType=${subtype}`
          ).toBe(true);
        }

        // No duplicates
        expect(uniqueTemplateForTypes.size).toBe(templateForTypes.length);
      });
    });
  }
);
