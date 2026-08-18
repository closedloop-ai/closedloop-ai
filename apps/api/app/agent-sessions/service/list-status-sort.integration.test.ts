import { SESSION_STATUS } from "@repo/api/src/types/session-status";
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

// FEA-4301: the Status column sorts by the PROJECTED (displayed) status, not the
// raw persisted `artifact.status`. A row that DISPLAYS as Waiting stores status
// `active` and derives Waiting from `awaitingInputSince` (mirroring the Status
// facet predicate). The old DB order-by on `artifact.status` sorted that row
// among the Active rows; the display-value sort path here projects the status the
// same way the row renders, so a displayed-Waiting row sorts as Waiting and stays
// contiguous. These integration tests drive `findSessions` end-to-end and assert
// the emitted item order groups monotonically by DISPLAYED status.
describe("agentSessionsService status display-value sort (FEA-4301)", () => {
  const AWAITING_SINCE = new Date("2026-05-20T17:05:00.000Z");

  // One candidate per displayed status. The displayed-Waiting row is the crux:
  // stored status `active` + `awaitingInputSince` set + not ended → Waiting.
  function statusCandidate(
    artifactId: string,
    opts: {
      storedStatus: string;
      awaitingInputSince?: Date | null;
      sessionEndedAt?: Date | null;
      lastActivityAt?: Date | null;
    }
  ) {
    return {
      artifactId,
      sessionStartedAt: new Date("2026-05-20T17:00:00.000Z"),
      sessionEndedAt: opts.sessionEndedAt ?? null,
      // ISS-5366: a FRESH staleness anchor. The displayed-status projection now
      // folds an `active` row silent past the display threshold to `stale`, and
      // these fixtures assert the lifecycle ORDER, not the staleness rule — with
      // the previous `null` anchor the row fell back to the fixed 2026-05-20
      // start date and turned Stale purely because wall-clock time had passed,
      // sorting the Active row to the end of the page.
      lastActivityAt: opts.lastActivityAt ?? new Date(),
      awaitingInputSince: opts.awaitingInputSince ?? null,
      artifact: { status: opts.storedStatus },
      user: null,
    };
  }

  // The display-value path fetches a candidate set (no id `IN` clause), orders it
  // in memory, then hydrates the page ids via a `WHERE id IN` query. Discriminate
  // on the id clause so the wiring is call-order-independent.
  function installStatusSortDb(
    candidates: ReturnType<typeof statusCandidate>[],
    fullRowsById: Map<string, Record<string, unknown>>
  ) {
    const findMany = vi
      .fn()
      .mockImplementation((args: { where: { AND?: unknown[] } }) => {
        const idClause = (args.where.AND?.[1] ?? {}) as {
          artifactId?: { in?: string[] };
        };
        const ids = idClause.artifactId?.in;
        if (ids === undefined) {
          return Promise.resolve(candidates);
        }
        const rows = ids
          .map((id) => fullRowsById.get(id))
          .filter((row): row is Record<string, unknown> => row !== undefined);
        return Promise.resolve(rows);
      });
    installDb({
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(5) },
    });
    return findMany;
  }

  // The five displayed-status rows. `waiting` stores `active` + awaitingInputSince
  // (the FEA-4301 case); every other row's displayed status IS its stored status.
  function buildFiveStatusRows() {
    const candidates = [
      // Deliberately shuffled so the emitted order proves the sort, not input order.
      statusCandidate("row-completed", {
        storedStatus: SESSION_STATUS.INACTIVE,
        sessionEndedAt: new Date("2026-05-20T17:10:00.000Z"),
      }),
      statusCandidate("row-waiting", {
        storedStatus: SESSION_STATUS.ACTIVE,
        awaitingInputSince: AWAITING_SINCE,
      }),
      statusCandidate("row-abandoned", {
        storedStatus: SESSION_STATUS.INACTIVE,
        sessionEndedAt: new Date("2026-05-20T17:10:00.000Z"),
      }),
      statusCandidate("row-active", {
        storedStatus: SESSION_STATUS.ACTIVE,
      }),
      statusCandidate("row-error", {
        storedStatus: SESSION_STATUS.ERROR,
        sessionEndedAt: new Date("2026-05-20T17:10:00.000Z"),
      }),
    ];
    const fullRows = new Map(
      candidates.map((c) => [
        c.artifactId,
        buildSessionListRecord({
          artifactId: c.artifactId,
          awaitingInputSince: c.awaitingInputSince,
          sessionEndedAt: c.sessionEndedAt,
          artifact: {
            organizationId: "org-1",
            name: c.artifactId,
            status: c.artifact.status,
            slug: c.artifactId,
            project: {
              id: "project-1",
              name: "Agent Platform",
              slug: "agent-platform",
            },
            sourceLinks: [],
          },
        }),
      ])
    );
    return { candidates, fullRows };
  }

  it("orders Status ASC by the DISPLAYED status: Active → Waiting → Inactive → Error", async () => {
    const { candidates, fullRows } = buildFiveStatusRows();
    installStatusSortDb(candidates, fullRows);

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { sortBy: "status", sortDir: "asc", quality: "all" },
    });

    // The displayed-Waiting row (stored `active`) sorts as Waiting — BETWEEN the
    // Active and Inactive rows. ISS-4586: completed/abandoned share the Inactive
    // rank (they render as one "Inactive" state) and group contiguously before
    // Error; the intra-group order falls to the stable artifactId tiebreaker.
    expect(result.items.map((item) => item.id)).toEqual([
      "row-active",
      "row-waiting",
      "row-completed",
      "row-abandoned",
      "row-error",
    ]);
  });

  it("orders Status DESC as the exact reverse of the displayed-status ranking", async () => {
    const { candidates, fullRows } = buildFiveStatusRows();
    installStatusSortDb(candidates, fullRows);

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { sortBy: "status", sortDir: "desc", quality: "all" },
    });

    expect(result.items.map((item) => item.id)).toEqual([
      "row-error",
      "row-completed",
      "row-abandoned",
      "row-waiting",
      "row-active",
    ]);
  });

  it("keeps every displayed-Waiting row contiguous even though each stores status active", async () => {
    // Three awaiting-input rows (stored `active`) interleaved with genuine Active
    // and Completed rows. On the DISPLAYED sort the three Waiting rows form one
    // contiguous block between the Active and Completed rows — the raw-status
    // order-by would have scattered them among the Active rows.
    const candidates = [
      statusCandidate("active-a", { storedStatus: SESSION_STATUS.ACTIVE }),
      statusCandidate("waiting-a", {
        storedStatus: SESSION_STATUS.ACTIVE,
        awaitingInputSince: AWAITING_SINCE,
      }),
      statusCandidate("completed-a", {
        storedStatus: SESSION_STATUS.INACTIVE,
        sessionEndedAt: new Date("2026-05-20T17:10:00.000Z"),
      }),
      statusCandidate("waiting-b", {
        storedStatus: SESSION_STATUS.ACTIVE,
        awaitingInputSince: AWAITING_SINCE,
      }),
      statusCandidate("active-b", { storedStatus: SESSION_STATUS.ACTIVE }),
      statusCandidate("waiting-c", {
        storedStatus: SESSION_STATUS.ACTIVE,
        awaitingInputSince: AWAITING_SINCE,
      }),
    ];
    const fullRows = new Map(
      candidates.map((c) => [
        c.artifactId,
        buildSessionListRecord({
          artifactId: c.artifactId,
          awaitingInputSince: c.awaitingInputSince,
          sessionEndedAt: c.sessionEndedAt,
          artifact: {
            organizationId: "org-1",
            name: c.artifactId,
            status: c.artifact.status,
            slug: c.artifactId,
            project: {
              id: "project-1",
              name: "Agent Platform",
              slug: "agent-platform",
            },
            sourceLinks: [],
          },
        }),
      ])
    );
    const findMany = vi
      .fn()
      .mockImplementation((args: { where: { AND?: unknown[] } }) => {
        const idClause = (args.where.AND?.[1] ?? {}) as {
          artifactId?: { in?: string[] };
        };
        const ids = idClause.artifactId?.in;
        if (ids === undefined) {
          return Promise.resolve(candidates);
        }
        return Promise.resolve(
          ids
            .map((id) => fullRows.get(id))
            .filter((row): row is Record<string, unknown> => row !== undefined)
        );
      });
    installDb({
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(6) },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { sortBy: "status", sortDir: "asc", quality: "all" },
    });

    const orderedIds = result.items.map((item) => item.id);
    // The three Waiting rows are one contiguous run.
    const waitingIds = orderedIds.filter((id) => id.startsWith("waiting-"));
    const firstWaiting = orderedIds.indexOf(waitingIds[0]);
    const lastWaiting = orderedIds.indexOf(waitingIds.at(-1) as string);
    expect(waitingIds).toHaveLength(3);
    expect(lastWaiting - firstWaiting).toBe(2);
    // The whole run: both Active rows, then all three Waiting rows, then Completed.
    expect(orderedIds.slice(0, 2).sort()).toEqual(["active-a", "active-b"]);
    expect(orderedIds.slice(2, 5).sort()).toEqual([
      "waiting-a",
      "waiting-b",
      "waiting-c",
    ]);
    expect(orderedIds.at(-1)).toBe("completed-a");
  });
});
