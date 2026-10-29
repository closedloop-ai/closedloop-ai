import { SESSION_STATUS } from "@repo/api/src/types/session-status";
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
 * ISS-10629 collapsed the Sessions status FILTER to the three PERSISTED
 * statuses, so the four display-projection SHAPE cases this file opened with
 * (Stale as Active's complement, Unknown by exclusion, and Active carrying the
 * awaiting-input and staleness exclusions) pin a predicate the list no longer
 * builds. They are deleted rather than re-homed: the contract that replaced
 * them — plain equality on `artifacts.status`, and a retired value narrowing to
 * an unsatisfiable `{ in: [] }` instead of widening — already has its own cases
 * in `query-builder.test.ts`, and copying them here would be a second
 * declaration of one contract.
 *
 * What survives is the pair below that the replacement does NOT cover: the
 * Inactive facet's no-widening shape, and the seeded-population reads.
 */
describe("Status facet predicate shape (ISS-5592 / ISS-10629)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the Inactive facet a plain equality, not a widening onto the retired pair (ISS-5592)", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
    });

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { status: SESSION_STATUS.INACTIVE, quality: "all" },
    });

    const where = findMany.mock.calls[0]?.[0].where as {
      AND?: unknown[];
      artifact?: { is?: { status?: unknown } };
    };
    // ISS-4586 had this widen onto `completed`/`abandoned` so the facet reached
    // not-yet-migrated rows. ISS-5981's total ingest fold removed the producer of
    // such a row and the ISS-4654 backfill collapsed the rest, so the widening
    // matched a population that cannot exist — and made the cloud disagree with
    // desktop, which never widened. This asserts the narrowed shape so the union
    // cannot come back unnoticed.
    expect(where.artifact?.is?.status).toBe(SESSION_STATUS.INACTIVE);
    // ISS-8488's reconciled arm — stored `active` beside an unfollowed end,
    // unioned in so the facet agreed with the badge — went with the projection.
    // Asserting the ABSENCE of a session-level clause is what keeps a derived
    // arm from being re-added on one side of the counts/list pair: any such arm
    // has to reference a SessionDetail column, so it cannot ride inside
    // `artifact.is` and would show up here.
    expect(where.AND).toBeUndefined();
  });
});

/*
 * ISS-5592: re-homed from the deleted ISS-4985 retired-input describe.
 *
 * These two assertions were never about the retired fold — they are the only
 * place in `apps/api/app/agent-sessions` that executes a status predicate against
 * a seeded population and reads the returned IDs, rather than asserting the shape
 * of the Prisma `where`. The shape tests run against a `findMany` that resolves
 * `[]` for every filter (whitlockk, #4737), so they cannot catch a predicate that
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

    // ISS-10629: the facet is equality on the stored column, so this reaches
    // the row that STORES `inactive` and only it. The `in-org-reconciled-*`
    // rows store `active` and are gathered by the Active facet instead.
    expect(ids).toEqual(["in-org-inactive"]);
    expect(ids).not.toContain("other-org-inactive");
  });

  it("does not over-fold — a non-Inactive status reaches only its own rows", async () => {
    // The counterfactual for the Inactive predicate: if it ever widens again, or
    // if ERROR folds the wrong way, this returns more than its own rows. The
    // seeded population holds a stored-`inactive` row and two stored-`active`
    // rows beside this one, so a fold in either direction is visible here.
    expect(await idsForStatus(SESSION_STATUS.ERROR)).toEqual(["in-org-error"]);
  });

  it("returns every row STORING active, rows carrying an end included (ISS-10629)", async () => {
    // ISS-10629 (operator ruling, 2026-09-17): the facet is equality on
    // `artifacts.status`, so every row storing `active` is returned whatever
    // end instant or `endsWithError` verdict it also carries.
    //
    // Pinned as four exact ids rather than a membership check so a facet that
    // quietly re-acquires a derived exclusion — the cheap
    // `sessionEndedAt IS NOT NULL` subtraction is the one that has been written
    // twice already — reddens here instead of passing on a subset.
    expect(await idsForStatus(SESSION_STATUS.ACTIVE)).toEqual([
      "in-org-active",
      "in-org-reconciled-inactive",
      "in-org-reconciled-error",
      "in-org-resumed-active",
    ]);
  });
});
