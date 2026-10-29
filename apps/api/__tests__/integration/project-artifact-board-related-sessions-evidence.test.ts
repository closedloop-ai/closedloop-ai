/**
 * ISS-12552 (PRD-800 "Rollout"): the project board's related sessions
 * filter keeps a card by the same evidence the Related Sessions cell counts
 * (ISS-12929). With `attribution-evidence-policy` on for an organization both
 * read operation evidence; with it off both read the classified links, as on
 * main. Two organizations hold the same fixture, one on and one off.
 */
import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import {
  AttributionRelationshipKind,
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRelatedSessionLink } from "@/__tests__/support/agent-sessions/related-session.test-fixtures";
import {
  type BoardFixture,
  readBoardRoots,
  seedBoardRoot,
  withBoardFixture,
} from "@/__tests__/support/artifacts/project-artifact-board.test-db";
import { listRelatedSessionsForArtifacts } from "@/app/agent-sessions/service/related-sessions";
import {
  createCommittedTestOrganizationTracker,
  createTestSessionDetail,
} from "../utils/db-helpers";

/** The flag is off for every organization not listed here. */
const flag = vi.hoisted(() => ({ onClerkOrganizationIds: new Set<string>() }));
vi.mock(
  "@/lib/feature-flags/server-feature-flag-evaluation",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/feature-flags/server-feature-flag-evaluation")
    >()),
    evaluateServerFeatureFlagForOrganization: vi.fn(
      (_flag: unknown, clerkOrganizationId: string) =>
        Promise.resolve(flag.onClerkOrganizationIds.has(clerkOrganizationId))
    ),
  })
);

const organizations = createCommittedTestOrganizationTracker();

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 board related sessions filter reads the cell's evidence",
  () => {
    afterEach(async () => {
      flag.onClerkOrganizationIds.clear();
      await organizations.cleanup();
    });

    it("keeps the cards the Related Sessions cell counts, by evidence with the flag on and by links with it off", async () => {
      await withBoardFixture(organizations, async (on) => {
        await withBoardFixture(organizations, async (off) => {
          await turnFlagOn(on.organizationId);
          const onRoots = await seedRelatedSessionFixture(on);
          const offRoots = await seedRelatedSessionFixture(off);

          const onKept = await filteredRoots(on, onRoots.session);
          expect(onKept).toEqual(
            [onRoots.evidenced, onRoots.branchLane].sort()
          );
          expect(onKept).toEqual(
            await rootsTheCellCounts(on, onRoots, onRoots.session)
          );

          const offKept = await filteredRoots(off, offRoots.session);
          expect(offKept).toEqual(
            [offRoots.linked, offRoots.branchLane].sort()
          );
          expect(offKept).toEqual(
            await rootsTheCellCounts(off, offRoots, offRoots.session)
          );
        });
      });
    });
  }
);

type RelatedSessionFixture = {
  session: string;
  /** Named by operation evidence only. */
  evidenced: string;
  /** Named by a slug-lane link only, which evidence treats as a mention. */
  linked: string;
  /** Named by a branch-lane link both reads count. */
  branchLane: string;
  /** Named by nothing. */
  unrelated: string;
};

async function seedRelatedSessionFixture(
  fixture: BoardFixture
): Promise<RelatedSessionFixture> {
  const session = await createTestSessionDetail({
    label: "related",
    organizationId: fixture.organizationId,
    userId: fixture.userId,
  });
  const roots = {
    evidenced: await seedBoardRoot(fixture, {
      name: "Evidenced",
      sortOrder: 0,
      status: DocumentStatus.Draft,
      subtype: ArtifactSubtype.Prd,
    }),
    linked: await seedBoardRoot(fixture, {
      name: "Linked",
      sortOrder: 1,
      status: IssueStatus.Todo,
    }),
    branchLane: await seedBoardRoot(fixture, {
      name: "Branch lane",
      sortOrder: 2,
      status: "open",
      type: ArtifactType.Branch,
    }),
    unrelated: await seedBoardRoot(fixture, {
      name: "Unrelated",
      sortOrder: 3,
      status: IssueStatus.Todo,
    }),
  };
  await writeRevisionEvidence(fixture.organizationId, session, roots.evidenced);
  await createRelatedSessionLink({
    contributedAt: "2026-10-01T00:00:00.000Z",
    organizationId: fixture.organizationId,
    sourceId: session,
    targetId: roots.linked,
  });
  await createRelatedSessionLink({
    branchParticipation: BranchParticipationKind.Wrote,
    contributedAt: "2026-10-01T00:00:00.000Z",
    organizationId: fixture.organizationId,
    sourceId: session,
    targetId: roots.branchLane,
  });
  return { session, ...roots };
}

async function filteredRoots(
  fixture: BoardFixture,
  session: string
): Promise<string[]> {
  const { rootIds } = await readBoardRoots(fixture, {
    relatedSessionIds: [session],
  });
  return [...rootIds].sort();
}

/** The seeded roots whose Related Sessions cell names the session. */
async function rootsTheCellCounts(
  fixture: BoardFixture,
  roots: RelatedSessionFixture,
  session: string
): Promise<string[]> {
  const candidates = [
    roots.evidenced,
    roots.linked,
    roots.branchLane,
    roots.unrelated,
  ];
  const cells = await listRelatedSessionsForArtifacts(
    fixture.organizationId,
    candidates,
    undefined,
    { sessionArtifactIds: [session] }
  );
  return candidates
    .filter((artifactId) => (cells[artifactId]?.total ?? 0) > 0)
    .sort();
}

async function turnFlagOn(organizationId: string): Promise<void> {
  const organization = await withDb((db) =>
    db.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { clerkId: true },
    })
  );
  flag.onClerkOrganizationIds.add(organization.clerkId);
}

async function writeRevisionEvidence(
  organizationId: string,
  agentSessionId: string,
  targetArtifactId: string
): Promise<void> {
  await withDb((db) =>
    db.agentSessionOperationEvidence.create({
      data: {
        organizationId,
        agentSessionId,
        claimKey: `claude:toolu_${targetArtifactId}`,
        targetArtifactId,
        relationshipKind: AttributionRelationshipKind.Revision,
        outcome: OperationReceiptOutcome.Committed,
        operationKind: OperationKind.UpdateFields,
        source: OperationSource.Mcp,
        invokedAt: new Date("2026-10-02T00:00:00.000Z"),
        extractorVersion: 1,
        policyVersion: 1,
      },
      select: { id: true },
    })
  );
}
