/**
 * ISS-12552 (AC-020): a headless Claude fork copies its parent's transcript
 * entries, uuids included, and a Desktop from before DATA REVISION 113 syncs
 * that copied usage as the fork's own. Allocation counts each Claude source
 * usage once among one owner's sessions, for the session that started first,
 * and reports a tie as ambiguous instead of settling it by sync order.
 */
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { ReconciliationFailureKind } from "@repo/lib/allocation/allocate-usage";
import { claudeTranscriptEntryUuidScheme } from "@repo/lib/harness/usage-dedup";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asCopiesOfOneSession,
  type OwnedUsageOrg,
  type OwnedUsageSession,
  ownedUsageOrganization,
  sessionWithUsage,
} from "@/__tests__/support/agent-sessions/attribution/owned-usage.test-fixtures";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { allocateSessionUsage } from "./session-allocation-service";

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: vi.fn(),
}));

const tracker = createCommittedTestOrganizationTracker();
const PARENT_START = new Date("2026-10-19T10:00:00.000Z");
const FORK_START = new Date("2026-10-19T11:00:00.000Z");
const OTHER_SCHEME = "test.per-file";

type Session = OwnedUsageSession;

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 usage owned by another session",
  () => {
    afterEach(() => tracker.cleanup());

    it("allocates a fork's copied usage, sent by an older Desktop, only to the parent that started first", async () => {
      const org = await organization();
      const parent = await sessionWithUsage(org, "parent", PARENT_START, [
        { uuid: "entry-1", input: 100n },
        { uuid: "entry-2", input: 200n },
      ]);
      const fork = await sessionWithUsage(org, "fork", FORK_START, [
        { uuid: "entry-1", input: 100n },
        { uuid: "entry-2", input: 200n },
        { uuid: "entry-3", input: 50n },
      ]);
      const stranger = await organization();
      await sessionWithUsage(stranger, "stranger", PARENT_START, [
        { uuid: "entry-3", input: 50n },
      ]);

      expect(await allocated(fork)).toEqual({ tokens: 50, micros: 50 });
      expect(await allocated(parent)).toEqual({ tokens: 300, micros: 300 });
    });

    it("lets a fork synced before its parent own the usage until the parent arrives", async () => {
      const org = await organization();
      const fork = await sessionWithUsage(org, "fork", FORK_START, [
        { uuid: "entry-1", input: 100n },
        { uuid: "entry-3", input: 50n },
      ]);

      expect(await allocated(fork)).toEqual({ tokens: 150, micros: 150 });

      await sessionWithUsage(org, "parent", PARENT_START, [
        { uuid: "entry-1", input: 100n },
      ]);

      expect(await allocated(fork)).toEqual({ tokens: 50, micros: 50 });
    });

    it("keeps an identity another scheme shares, since only a Claude entry uuid names a record across files", async () => {
      const org = await organization();
      await sessionWithUsage(org, "parent", PARENT_START, [
        { uuid: "L12", input: 100n, scheme: OTHER_SCHEME },
      ]);
      const later = await sessionWithUsage(org, "later", FORK_START, [
        { uuid: "L12", input: 100n, scheme: OTHER_SCHEME },
      ]);

      expect(await allocated(later)).toEqual({ tokens: 100, micros: 100 });
    });

    it("reports a usage two of the owner's sessions that started together both hold as ambiguous, whichever synced first", async () => {
      const org = await organization();
      const fork = await sessionWithUsage(org, "fork", PARENT_START, [
        { uuid: "entry-1", input: 100n },
        { uuid: "entry-2", input: 20n },
      ]);
      const parent = await sessionWithUsage(org, "parent", PARENT_START, [
        { uuid: "entry-1", input: 100n },
      ]);

      for (const tied of [fork, parent]) {
        const result = await allocateSessionUsage(tied);
        expect(result).toEqual({
          ok: false,
          error: {
            kind: ReconciliationFailureKind.AmbiguousSource,
            sourceKey: `${claudeTranscriptEntryUuidScheme}:entry-1`,
          },
        });
      }
    });

    it("dedupes a fork by Claude entry and copies of the fork by event id, so each usage is allocated once (PRD-800)", async () => {
      const org = await organization();
      const parent = await sessionWithUsage(org, "parent", PARENT_START, [
        { uuid: "entry-1", input: 100n },
      ]);
      const forkUnits = [
        { uuid: "entry-1", input: 100n, eventId: "token-event-fork-1" },
        { uuid: "entry-2", input: 20n, eventId: "token-event-fork-2" },
      ];
      const canonical = await sessionWithUsage(
        org,
        "fork-a",
        FORK_START,
        forkUnits
      );
      const other = await sessionWithUsage(
        org,
        "fork-b",
        FORK_START,
        forkUnits
      );
      await asCopiesOfOneSession([canonical, other]);

      expect(await allocated(parent)).toEqual({ tokens: 100, micros: 100 });
      expect(await allocated(canonical)).toEqual({ tokens: 20, micros: 20 });
      const copy = await allocateSessionUsage(other);
      expect(copy.ok && copy.value.allocation.totalTokens).toBe(0);
    });

    it("does not dedupe a session whose owner is null, since no owner proves no fork pair", async () => {
      const org = await organization();
      const parent = await sessionWithUsage(org, "parent", PARENT_START, [
        { uuid: "entry-1", input: 100n },
      ]);
      const fork = await sessionWithUsage(org, "fork", FORK_START, [
        { uuid: "entry-1", input: 100n },
      ]);
      await withDb((db) =>
        db.artifact.updateMany({
          where: {
            organizationId: org.id,
            id: { in: [parent.agentSessionId, fork.agentSessionId] },
          },
          data: { createdById: null },
        })
      );

      expect(await allocated(fork)).toEqual({ tokens: 100, micros: 100 });
    });

    it("never lets another member's earlier session take a session's usage", async () => {
      const org = await organization();
      const member = await createTestUser(org.id);
      await sessionWithUsage(
        { id: org.id, userId: member.id },
        "member",
        PARENT_START,
        [{ uuid: "entry-1", input: 100n }]
      );
      const own = await sessionWithUsage(org, "own", FORK_START, [
        { uuid: "entry-1", input: 100n },
      ]);

      expect(await allocated(own)).toEqual({ tokens: 100, micros: 100 });
    });
  }
);

function organization(): Promise<OwnedUsageOrg> {
  return ownedUsageOrganization(tracker);
}

async function allocated(
  session: Session
): Promise<{ tokens: number; micros: number }> {
  const result = await allocateSessionUsage(session);
  if (!result.ok) {
    throw new Error(`allocation failed: ${result.error.kind}`);
  }
  const { priced } = result.value;
  if (!priced) {
    throw new Error("the session has no stored cost");
  }
  return {
    tokens: result.value.allocation.totalTokens,
    micros: priced.recipients.reduce(
      (sum, share) => sum + share.provenMicros + share.estimatedMicros,
      priced.unattributedMicros
    ),
  };
}
