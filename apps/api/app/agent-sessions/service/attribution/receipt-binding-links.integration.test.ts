/**
 * ISS-12552: a sync that moves a receipt onto another
 * session syncs that session's evidence links too, so a finished session that
 * never syncs again still links what its evidence now proves, against a real
 * Postgres.
 */
import { LinkType } from "@repo/api/src/types/artifact";
import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-pr-link-metadata";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copiesOfFixtureSession,
  deleteReceipts,
  type EvidenceFixture,
  evidenceRows,
  ownerDocument,
  ownerSession,
  seedEvidenceFixture,
  syncClaims,
  updateClaim,
  writeReceipt,
} from "@/__tests__/support/agent-sessions/attribution/operation-evidence.test-helpers";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { runAttributionBackfill } from "./attribution-backfill";

/** The organization's attribution flag is on. */
vi.mock("@/lib/attribution-evidence-policy-feature", () => ({
  isAttributionEvidenceEnabledForOrganization: vi.fn(async () => true),
  evaluateAttributionEvidenceForOrganization: vi.fn(async () => true),
}));

const tracker = createCommittedTestOrganizationTracker();
const organizationIds: string[] = [];
/** Before the fixture session's own start (createTestSessionDetail's default). */
const EARLIER_START = new Date("2026-05-14T00:00:00Z");
/** Within a day of the claims, so the backfill finalizes nothing. */
const BACKFILL_NOW = new Date("2026-10-16T13:00:00Z");

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 links of a session another session's sync bound",
  () => {
    afterEach(async () => {
      await deleteReceipts(organizationIds.splice(0));
      await tracker.cleanup();
    });

    it("links the canonical copy to what it created once the other copy's sync binds the receipt to it", async () => {
      const fixture = await seed();
      const { canonical, other } = await copiesOfFixtureSession(fixture);
      const created = await ownerDocument(fixture);
      const claim = createClaim(fixture);
      await syncClaims(canonical, fixture.organizationId, [claim]);
      // Its late bind never ran (it failed, or raced the canonical sync).
      const receiptId = await writeReceipt(fixture, {
        clientCallId: "toolu_created",
        operationKind: OperationKind.Create,
        createdArtifactId: created,
      });
      expect(await evidenceLinkTargets(canonical)).toEqual([]);

      await syncClaims(other, fixture.organizationId, [claim]);

      expect(await evidenceRows(canonical)).toEqual([
        expect.objectContaining({ receiptId, targetArtifactId: created }),
      ]);
      expect(await evidenceLinkTargets(canonical)).toEqual([created]);
    });

    it("links the parent to what it created once the backfill, visiting only the fork, binds the receipt to it", async () => {
      const fixture = await seed();
      // The walk goes by artifact id, so the fixture's session (a fork that
      // started later) is visited and the parent created after it is not.
      const fork = fixture.sessionId;
      const parent = await ownerSession(fixture, "parent", EARLIER_START);
      const created = await ownerDocument(fixture);
      const claim = createClaim(fixture);
      await syncClaims(fork, fixture.organizationId, [claim]);
      await syncClaims(parent, fixture.organizationId, [claim]);
      const receiptId = await writeReceipt(fixture, {
        clientCallId: "toolu_created",
        operationKind: OperationKind.Create,
        createdArtifactId: created,
      });

      await runAttributionBackfill({
        organizationId: fixture.organizationId,
        pageSize: 1,
        maxPages: 1,
        now: BACKFILL_NOW,
      });

      expect(await evidenceRows(parent)).toEqual([
        expect.objectContaining({ receiptId, targetArtifactId: created }),
      ]);
      expect(await evidenceLinkTargets(parent)).toEqual([created]);
    });
  }
);

function createClaim(fixture: EvidenceFixture) {
  return updateClaim("toolu_created", fixture.documentId, {
    toolName: "create-document",
    operationKind: OperationKind.Create,
    inputTargets: [],
  });
}

async function seed(): Promise<EvidenceFixture> {
  const fixture = await seedEvidenceFixture(tracker);
  organizationIds.push(fixture.organizationId);
  return fixture;
}

async function evidenceLinkTargets(sessionId: string): Promise<string[]> {
  const links = await withDb((db) =>
    db.artifactLink.findMany({
      where: {
        sourceId: sessionId,
        linkType: LinkType.RelatesTo,
        metadata: {
          path: ["linkKind"],
          equals: SessionArtifactLinkKind.SessionEvidence,
        },
      },
      select: { targetId: true },
    })
  );
  return links.map((link) => link.targetId);
}
