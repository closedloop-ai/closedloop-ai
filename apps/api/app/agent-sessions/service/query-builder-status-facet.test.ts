import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installDb } from "@/__tests__/support/agent-sessions/service.test-harness";
import {
  installSeededSessionStatusDb,
  SEEDED_ORGANIZATION_ID,
} from "@/__tests__/support/agent-sessions/session-status-population";
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

/**
 * ISS-5366: the Status-facet predicates for the two DISPLAY-ONLY statuses,
 * split out of `query-builder.test.ts` (that file is at the 1,000-line hard
 * ceiling — see AGENTS.md -> "File Size and Organization").
 *
 * These assert the invariant the whole change rests on: the Status facet and
 * the Status badge describe the SAME population. Retiring
 * `sessions-honest-unknown-states` made the mapper badge rows "Stale"/"Unknown"
 * for every user, so a facet that could not reach them left the filter and the
 * grid telling two stories about one row.
 */
describe("Status facet predicates for the display-only statuses (ISS-5366)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("splits Stale out of Active as a complementary partition", async () => {
    // The two predicates must PARTITION the old Active population: every row
    // the Active facet now excludes for staleness is exactly a row the Stale
    // facet returns, so nothing is lost between them and nothing is in both.
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
    });

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { status: DISPLAYED_SESSION_STATUS.STALE, quality: "all" },
    });

    const where = findMany.mock.calls[0]?.[0].where as {
      AND?: Record<string, unknown>[];
    };
    expect(where.AND).toEqual([
      {
        OR: [
          { artifact: { is: { status: "stale" } } },
          {
            awaitingInputSince: null,
            artifact: { is: { status: "active" } },
            OR: [
              // ISS-4556: `not: null` alongside the cutoff. A bare
              // `last_activity_at < $cutoff` is SQL NULL — not false — for the
              // nullable column, and the ACTIVE facet NEGATES this same
              // disjunction, so `NOT NULL` = NULL left a null-activity row out
              // of both facets. The guard keeps the branch two-valued.
              { lastActivityAt: { not: null, lt: expect.any(Date) } },
              {
                lastActivityAt: null,
                sessionStartedAt: { lt: expect.any(Date) },
              },
            ],
          },
        ],
      },
    ]);
  });

  it("reaches version-skewed rows through the Unknown facet by exclusion", async () => {
    // An unrecognized status cannot be listed, so the only way a query can
    // gather the rows the column badges "Unknown" is to exclude the recognized
    // ones. `unknown` itself is NOT excluded — a row storing it displays as
    // Unknown too — while `stale` IS, because it folds to Stale.
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
    });

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { status: DISPLAYED_SESSION_STATUS.UNKNOWN, quality: "all" },
    });

    const where = findMany.mock.calls[0]?.[0].where as {
      AND?: { artifact: { is: { status: { notIn: string[] } } } }[];
    };
    const excluded = where.AND?.[0]?.artifact.is.status.notIn ?? [];
    expect(excluded).toContain(SESSION_STATUS.ACTIVE);
    expect(excluded).toContain(SESSION_STATUS.ERROR);
    expect(excluded).toContain(DISPLAYED_SESSION_STATUS.STALE);
    expect(excluded).not.toContain(DISPLAYED_SESSION_STATUS.UNKNOWN);
  });

  it("keeps BOTH the displays-as-Waiting and the staleness exclusion on Active (ISS-4556 / ISS-4559)", async () => {
    // Two independent exclusions in one predicate. `NOT` is a single reserved key
    // in a Prisma `where`, so expressing them as two `NOT`s in the same object
    // literal makes the second silently overwrite the first — which is exactly
    // what happened when the ISS-4559 branch met the ISS-5366 staleness cutoff.
    // The awaiting-input exclusion is therefore spelled as a disjunction, and
    // this test fails if either exclusion goes missing.
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
    });

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      displayedStatusParity: true,
      filters: { status: SESSION_STATUS.ACTIVE, quality: "all" },
    });

    const where = findMany.mock.calls[0]?.[0].where as {
      AND?: Record<string, unknown>[];
    };
    expect(where.AND?.[0]).toEqual({
      // NOT(awaiting set AND not ended), written so the predicate does not
      // depend on how Prisma reads a multi-key `NOT`.
      OR: [{ awaitingInputSince: null }, { sessionEndedAt: { not: null } }],
      artifact: { is: { status: SESSION_STATUS.ACTIVE } },
      NOT: {
        OR: [
          // ISS-4556: see the sibling assertion — the `not: null` is what stops
          // this negation from evaluating to SQL NULL, and being rejected by
          // `WHERE`, for a row whose `lastActivityAt` is null.
          { lastActivityAt: { not: null, lt: expect.any(Date) } },
          { lastActivityAt: null, sessionStartedAt: { lt: expect.any(Date) } },
        ],
      },
    });
  });
});

/*
 * ISS-5592: re-homed from the deleted ISS-4985 retired-input describe.
 *
 * These two assertions were never about the retired fold — they are the only
 * place in `apps/api/app/agent-sessions` that executes a status predicate against
 * a seeded population and reads the returned IDs, rather than asserting the shape
 * of the Prisma `where`. The shape tests run against a `findMany` that resolves
 * `[]` for every filter (wongk, #4737), so they cannot catch a predicate that
 * builds correctly and then returns the wrong rows — including one that drops its
 * org scope.
 *
 * Deleting the retired describe took the org-isolation proof with it and orphaned
 * `session-status-population.ts`. Both are restored here.
 */
describe("Status facet population (org scoping + over-fold counterfactual)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function idsForStatus(status: string): Promise<string[]> {
    installSeededSessionStatusDb();
    const result = await agentSessionsService.findSessions({
      organizationId: SEEDED_ORGANIZATION_ID,
      filters: { status, quality: "all" },
    });
    return result.items.map((item) => item.id);
  }

  it("never crosses the org boundary", async () => {
    const ids = await idsForStatus(SESSION_STATUS.INACTIVE);

    expect(ids).toEqual(["in-org-inactive"]);
    expect(ids).not.toContain("other-org-inactive");
  });

  it("does not over-fold — a non-Inactive status reaches only its own rows", async () => {
    // The counterfactual for the Inactive predicate: if it ever widens again, or
    // if ERROR starts folding, this returns more than its own row.
    expect(await idsForStatus(SESSION_STATUS.ERROR)).toEqual(["in-org-error"]);
  });
});
