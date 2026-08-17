// ISS-4828: the CLOUD READ BOUNDARY contract for the two compute-target sync
// watermarks.
//
// ISS-4678 narrowed `ComputeTarget.lastAgentSessionSyncAt` to advance ONLY when
// session rows actually land — an accepted empty / all-foreign-chunk batch no
// longer touches it. Every reader that still described that column as "the
// target's most recent sync" therefore became wrong at the moment the narrowing
// shipped: a target that had demonstrably just synced fine kept showing the
// older timestamp, on the same row as `online` + a 20-second-old `lastSeenAt`.
//
// The fix is to serve BOTH: the landed-data watermark keeps its (now correctly
// documented) meaning, and ISS-4827's accepted-sync watermark
// (`lastAgentSessionSyncAttemptAt`) carries the "did it sync?" answer. These
// tests pin that AT THE PROJECTION BOUNDARY — the shared `toSessionListItem`
// read path behind both the list and the detail — so a future change cannot
// quietly collapse the two fields back into one, or drop the new one on the
// floor while the type still advertises it.

import { describe, expect, it, vi } from "vitest";
import {
  buildSessionListRecord,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

const LAST_INGEST_AT = new Date("2026-07-28T09:00:00.000Z");
const LAST_SEEN_AT = new Date("2026-07-31T11:59:40.000Z");
const LAST_ACCEPTED_SYNC_AT = new Date("2026-07-31T11:59:30.000Z");

/**
 * The exact shape ISS-4828 describes: a target that is ONLINE, was seen 20
 * seconds ago, had a batch ACCEPTED 30 seconds ago that carried no new sessions
 * — and whose last actually-landed session data is three days old.
 */
function installOnlineTargetWithStaleIngest() {
  installDb({
    sessionDetail: {
      findMany: vi.fn().mockResolvedValue([
        buildSessionListRecord({
          artifact: {
            name: "Session on an online, idle target",
            status: "completed",
            slug: "SES-4828",
            project: null,
            sourceLinks: [],
          },
          computeTarget: {
            id: "target-4828",
            machineName: "Ada's MacBook Pro",
            isOnline: true,
            lastSeenAt: LAST_SEEN_AT,
            lastAgentSessionSyncAt: LAST_INGEST_AT,
            lastAgentSessionSyncAttemptAt: LAST_ACCEPTED_SYNC_AT,
          },
        }),
      ]),
      count: vi.fn().mockResolvedValue(1),
    },
  });
}

describe("agent-session projection — compute-target sync watermarks (ISS-4828)", () => {
  it("serves the LANDED-DATA watermark unchanged for an accepted zero-row batch while the target stays online", async () => {
    installOnlineTargetWithStaleIngest();

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    const computeTarget = result.items[0]?.computeTarget;
    // The landed-data watermark is NOT dragged forward by the accepted zero-row
    // batch: it still reports when session rows last actually landed.
    expect(computeTarget?.lastAgentSessionSyncAt).toEqual(LAST_INGEST_AT);
    // ...and the target is unambiguously live on the very same row, which is
    // what made the single-field presentation read as a contradiction.
    expect(computeTarget?.isOnline).toBe(true);
    expect(computeTarget?.lastSeenAt).toEqual(LAST_SEEN_AT);
  });

  it("serves the ACCEPTED-sync watermark alongside it, so a reader can tell 'synced' from 'ingested'", async () => {
    installOnlineTargetWithStaleIngest();

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    const computeTarget = result.items[0]?.computeTarget;
    expect(computeTarget?.lastAgentSessionSyncAttemptAt).toEqual(
      LAST_ACCEPTED_SYNC_AT
    );
    // The two are genuinely different values on this row — the whole point. A
    // projection that collapsed them would satisfy neither assertion above.
    expect(computeTarget?.lastAgentSessionSyncAttemptAt).not.toEqual(
      computeTarget?.lastAgentSessionSyncAt
    );
  });

  it("serves a never-accepted target's accepted-sync watermark as null rather than borrowing the ingest time", async () => {
    // A freshly-registered target that has never had a batch accepted has no
    // accepted-sync time. Null is the honest representation of "unknown"; a
    // fallback to the ingest watermark would invent a sync that never happened.
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            artifact: {
              name: "Session on a never-accepted target",
              status: "completed",
              slug: "SES-4828-null",
              project: null,
              sourceLinks: [],
            },
            computeTarget: {
              id: "target-4828-null",
              machineName: "Fresh Machine",
              isOnline: false,
              lastSeenAt: LAST_SEEN_AT,
              lastAgentSessionSyncAt: LAST_INGEST_AT,
              lastAgentSessionSyncAttemptAt: null,
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(
      result.items[0]?.computeTarget?.lastAgentSessionSyncAttemptAt
    ).toBeNull();
    expect(result.items[0]?.computeTarget?.lastAgentSessionSyncAt).toEqual(
      LAST_INGEST_AT
    );
  });
});
