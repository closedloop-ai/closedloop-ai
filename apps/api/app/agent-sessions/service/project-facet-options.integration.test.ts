import { randomUUID } from "node:crypto";
import { LinkType } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import { DocumentStatus } from "@repo/api/src/types/document";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { observeStatements } from "@/__tests__/support/db-statement-observer";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { buildProjectFacetOptions } from "./project-facet-options";
import type { SessionUsageInput } from "./records";
import { buildUsageSummaryWhere } from "./usage-summary-where";

/**
 * ISS-11895 — the Project facet's counts against real Postgres.
 *
 * The counts are a SQL aggregate (`sessionProjectCountsSql`) while the list
 * filters by a Prisma `where` (`buildProjectLinkWhere`), so these pin that the
 * two spellings of the edge agree, that the aggregate keeps the facet's
 * exclusions, and that the read no longer ships a row per link.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const WINDOW_START = "2026-09-03T00:00:00.000Z";
const WINDOW_END = "2026-10-02T23:59:59.999Z";
const IN_WINDOW = new Date("2026-09-20T09:00:00.000Z");
const BEFORE_WINDOW = new Date("2026-03-10T09:00:00.000Z");
const EXTRA_LINKS_PER_SESSION = 20;

describeIfDb("Project facet counts (ISS-11895)", () => {
  it("counts distinct sessions per project over RELATES_TO links to documents", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedFixture();
      await seedUnlistedEdges(fixture);
      await seedForeignEdges(fixture);

      const options = await buildProjectFacetOptions(
        fixture.organizationId,
        await buildUsageSummaryWhere(usageInput(fixture))
      );

      expect(options).toEqual([
        { projectId: fixture.alpha, projectName: "Alpha", sessionCount: 2 },
        { projectId: fixture.beta, projectName: "Beta", sessionCount: 1 },
      ]);
    });
  });

  it("equals the row count of the list filtered to each project", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedFixture();
      await seedUnlistedEdges(fixture);

      const options = await buildProjectFacetOptions(
        fixture.organizationId,
        await buildUsageSummaryWhere(usageInput(fixture))
      );

      const listed = await Promise.all(
        options.map(async (option) => {
          const where = await buildUsageSummaryWhere(
            usageInput(fixture, [option.projectId])
          );
          return withDb((db) => db.sessionDetail.count({ where }));
        })
      );
      expect(options.length).toBeGreaterThan(0);
      expect(options.map((option) => option.sessionCount)).toEqual(listed);
    });
  });

  it("reads one row per session and one per project, however many links each session has", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedFixture();
      const where = await buildUsageSummaryWhere(usageInput(fixture));
      const read = () =>
        observeStatements(() =>
          buildProjectFacetOptions(fixture.organizationId, where)
        );
      const before = await read();

      for (const sessionId of fixture.alphaSessions) {
        for (let index = 0; index < EXTRA_LINKS_PER_SESSION; index++) {
          const document = await seedDocument(fixture, fixture.alpha);
          await seedLink(fixture.organizationId, sessionId, document);
        }
      }
      const after = await read();

      const shape = (observed: typeof before) =>
        observed.statements.map((statement) => statement.rows);
      // Three in-window sessions, then Alpha and Beta.
      expect(shape(before)).toEqual([3, 2]);
      expect(shape(after)).toEqual(shape(before));
      expect(after.result).toEqual(before.result);
    });
  });
});

type Fixture = {
  organizationId: string;
  userId: string;
  alpha: string;
  beta: string;
  /** The two in-window sessions Alpha counts. */
  alphaSessions: string[];
  /** In window, with no link the facet counts. */
  unlinkedSession: string;
};

function usageInput(
  fixture: Fixture,
  projectIds?: string[]
): SessionUsageInput {
  return {
    organizationId: fixture.organizationId,
    filters: {
      startDate: WINDOW_START,
      endDate: WINDOW_END,
      ...(projectIds ? { projectIds } : {}),
    },
  };
}

/**
 * S1 links three Alpha documents (one session, not three); S2 links one Alpha
 * and one Beta document; S3 links nothing; S4, before the window, links Alpha.
 */
async function seedFixture(): Promise<Fixture> {
  const organizationId = await createTestOrganization();
  const { id: userId } = await createTestUser(organizationId);
  const alpha = await createTestProject(organizationId, userId, {
    name: "Alpha",
  });
  const beta = await createTestProject(organizationId, userId, {
    name: "Beta",
  });
  const [s1, s2, s3] = await Promise.all(
    ["s1", "s2", "s3"].map((label) =>
      createTestSessionDetail({
        organizationId,
        userId,
        label,
        sessionTimestamp: IN_WINDOW,
      })
    )
  );
  const s4 = await createTestSessionDetail({
    organizationId,
    userId,
    label: "s4",
    sessionTimestamp: BEFORE_WINDOW,
  });
  const fixture = {
    organizationId,
    userId,
    alpha,
    beta,
    alphaSessions: [s1, s2],
    unlinkedSession: s3,
  };
  const [a1, a2, a3, b1] = await Promise.all([
    seedDocument(fixture, alpha),
    seedDocument(fixture, alpha),
    seedDocument(fixture, alpha),
    seedDocument(fixture, beta),
  ]);
  for (const target of [a1, a2, a3]) {
    await seedLink(organizationId, s1, target);
  }
  await seedLink(organizationId, s2, a1);
  await seedLink(organizationId, s2, b1);
  await seedLink(organizationId, s4, a1);
  return fixture;
}

/**
 * Edges neither the facet nor the list filter counts, from an in-window session
 * of this org: a PRODUCES link to a Beta document, a link to an unparented
 * document, and a link to a non-document artifact in Alpha.
 */
async function seedUnlistedEdges(fixture: Fixture): Promise<void> {
  const { organizationId, alpha, beta, unlinkedSession: s3 } = fixture;
  await seedLink(
    organizationId,
    s3,
    await seedDocument(fixture, beta),
    LinkType.Produces
  );
  await seedLink(organizationId, s3, await seedDocument(fixture, null));
  const branch = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        status: BranchStatus.Open,
        name: `branch-${randomUUID().slice(0, 8)}`,
        projectId: alpha,
      },
      select: { id: true },
    })
  );
  await seedLink(organizationId, s3, branch.id);
}

/**
 * Edges the facet does not count, as the link read it replaces did not: from an
 * in-window session of this org, a link to a document whose project belongs to
 * another org, and a link stamped with another org to an Alpha document; and a
 * link stamped with this org from another org's in-window session.
 */
async function seedForeignEdges(fixture: Fixture): Promise<void> {
  const { organizationId, alpha, unlinkedSession: s3 } = fixture;
  const foreignOrganizationId = await createTestOrganization();
  const { id: foreignUserId } = await createTestUser(foreignOrganizationId);
  const foreignProject = await createTestProject(
    foreignOrganizationId,
    foreignUserId,
    { name: "Foreign" }
  );
  await seedLink(
    organizationId,
    s3,
    await seedDocument(fixture, foreignProject)
  );
  await seedLink(foreignOrganizationId, s3, await seedDocument(fixture, alpha));
  const foreignSession = await createTestSessionDetail({
    organizationId: foreignOrganizationId,
    userId: foreignUserId,
    label: "foreign",
    sessionTimestamp: IN_WINDOW,
  });
  await seedLink(
    organizationId,
    foreignSession,
    await seedDocument(fixture, alpha)
  );
}

async function seedDocument(
  fixture: Pick<Fixture, "organizationId">,
  projectId: string | null
): Promise<string> {
  const document = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId: fixture.organizationId,
        type: ArtifactType.DOCUMENT,
        status: DocumentStatus.Draft,
        name: `doc-${randomUUID().slice(0, 8)}`,
        projectId,
      },
      select: { id: true },
    })
  );
  return document.id;
}

async function seedLink(
  organizationId: string,
  sourceId: string,
  targetId: string,
  linkType: LinkType = LinkType.RelatesTo
): Promise<void> {
  await withDb((db) =>
    db.artifactLink.create({
      data: { organizationId, sourceId, targetId, linkType },
      select: { id: true },
    })
  );
}
