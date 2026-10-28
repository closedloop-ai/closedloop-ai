import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { ArtifactRefRelation } from "@repo/api/src/types/session-artifact-link";
import { TokenCostCompleteness } from "@repo/api/src/types/token-cost-provenance";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { log } from "@repo/observability/log";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { InvalidCostEvidenceReason } from "./document-cost-coverage";
import { documentCostService } from "./document-cost-service";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const NOW = new Date("2026-10-02T12:00:00.000Z");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describeIfDb("document cost daily trendline (real Postgres)", () => {
  it("bins token events per UTC day in SQL, leaving incomplete, unpriced and corrupt days null", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const errorLog = vi.spyOn(log, "error").mockImplementation(() => undefined);

    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const sessionId = await createTestSessionDetail({
        organizationId,
        userId: user.id,
        label: "daily-cost",
      });
      const documentId = await withDb(async (db) => {
        const document = await db.artifact.create({
          data: {
            organizationId,
            type: ArtifactType.Document,
            subtype: DocumentType.Prd,
            name: "daily-cost-doc",
            status: DocumentStatus.Draft,
          },
          select: { id: true },
        });
        await db.artifactLink.create({
          data: {
            organizationId,
            sourceId: sessionId,
            targetId: document.id,
            linkType: LinkType.RelatesTo,
            metadata: { relation: ArtifactRefRelation.Created },
          },
          select: { id: true },
        });
        return document.id;
      });
      const seeded = [
        [
          "before-start",
          "2026-09-18T23:00:00Z",
          100,
          TokenCostCompleteness.Complete,
        ],
        ["day0-a", "2026-09-19T00:00:00Z", 1.5, TokenCostCompleteness.Complete],
        [
          "day0-b",
          "2026-09-19T23:59:59Z",
          2.25,
          TokenCostCompleteness.Complete,
        ],
        [
          "day3-priced",
          "2026-09-22T08:00:00Z",
          1,
          TokenCostCompleteness.Complete,
        ],
        ["day3-unclassified", "2026-09-22T09:00:00Z", 2, null],
        [
          "day5-priced",
          "2026-09-24T08:00:00Z",
          1,
          TokenCostCompleteness.Complete,
        ],
        [
          "day5-unpriced",
          "2026-09-24T09:00:00Z",
          null,
          TokenCostCompleteness.Complete,
        ],
        [
          "day8-partial",
          "2026-09-27T10:00:00Z",
          4,
          TokenCostCompleteness.Partial,
        ],
        [
          "day8-partial-corrupt",
          "2026-09-27T11:00:00Z",
          -3,
          TokenCostCompleteness.Partial,
        ],
        [
          "day10-corrupt",
          "2026-09-29T10:00:00Z",
          -1,
          TokenCostCompleteness.Complete,
        ],
        ["day13", "2026-10-02T11:00:00Z", 0.5, TokenCostCompleteness.Complete],
        [
          "after-now",
          "2026-10-02T13:00:00Z",
          9,
          TokenCostCompleteness.Complete,
        ],
      ] as const;
      const ids = new Map<string, string>();
      for (const [key, at, cost, completeness] of seeded) {
        const event = await withDb((db) =>
          db.agentSessionTokenEvent.create({
            data: {
              agentSessionId: sessionId,
              externalEventId: `daily-cost-${key}`,
              model: "claude-opus-5",
              estimatedCost: cost,
              costCompleteness: completeness,
              eventCreatedAt: new Date(at),
            },
            select: { id: true },
          })
        );
        ids.set(key, event.id);
      }

      const result = await documentCostService.read(organizationId, {
        artifactIds: [documentId],
      });

      const expected = new Array<number | null>(14).fill(0);
      expected[0] = 3.75;
      expected[3] = null;
      expected[5] = null;
      expected[8] = null;
      expected[10] = null;
      expected[13] = 0.5;
      expect(result.artifacts[0].trendline).toEqual(expected);
      // A corrupt cost on a Partial event is already a gap; only Complete events
      // are validated, as the per-event read did. ISS-12598 (#8868): the window
      // read also logs once for the session's corrupt Complete window.
      expect(errorLog).toHaveBeenCalledTimes(2);
      expect(errorLog).toHaveBeenCalledWith(
        "[document-cost] Invalid token-event cost",
        { organizationId, tokenEventId: ids.get("day10-corrupt") }
      );
      expect(errorLog).toHaveBeenCalledWith(
        "[document-cost] Invalid token-event cost",
        {
          organizationId,
          agentSessionId: sessionId,
          reason: InvalidCostEvidenceReason.WindowCost,
        }
      );
    });
  });

  it("never bins another organization's token events into the trendline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);

    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const otherOrganizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const otherUser = await createTestUser(otherOrganizationId);
      const ownSessionId = await createTestSessionDetail({
        organizationId,
        userId: user.id,
        label: "own-session",
      });
      const foreignSessionId = await createTestSessionDetail({
        organizationId: otherOrganizationId,
        userId: otherUser.id,
        label: "foreign-session",
      });
      const documentId = await withDb(async (db) => {
        const document = await db.artifact.create({
          data: {
            organizationId,
            type: ArtifactType.Document,
            subtype: DocumentType.Prd,
            name: "two-org-cost-doc",
            status: DocumentStatus.Draft,
          },
          select: { id: true },
        });
        // The foreign link is corrupt data: a row in this organization naming
        // another organization's session. The session read and the daily SQL
        // both filter by organization, so dropping either one alone stays green.
        await db.artifactLink.createMany({
          data: [ownSessionId, foreignSessionId].map((sourceId) => ({
            organizationId,
            sourceId,
            targetId: document.id,
            linkType: LinkType.RelatesTo,
            metadata: { relation: ArtifactRefRelation.Created },
          })),
        });
        return document.id;
      });
      await withDb((db) =>
        db.agentSessionTokenEvent.createMany({
          data: [
            { agentSessionId: ownSessionId, key: "own", cost: 1 },
            { agentSessionId: foreignSessionId, key: "foreign", cost: 7 },
          ].map(({ agentSessionId, key, cost }) => ({
            agentSessionId,
            externalEventId: `two-org-cost-${key}`,
            model: "claude-opus-5",
            estimatedCost: cost,
            costCompleteness: TokenCostCompleteness.Complete,
            eventCreatedAt: new Date("2026-10-02T11:00:00Z"),
          })),
        })
      );

      const result = await documentCostService.read(organizationId, {
        artifactIds: [documentId],
      });

      expect(result.artifacts[0].trendline?.[13]).toBe(1);
    });
  });
});
