import { describe, expect, it, vi } from "vitest";
import { installDb } from "@/__tests__/support/agent-sessions/service.test-harness";
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
 * ISS-9939 / ISS-10262: the Status column sorts by the PERSISTED
 * `artifact.status` column now, not the PROJECTED (displayed) status —
 * FEA-4301's contrary contract is knowingly superseded by the operator ruling
 * on ISS-9939. A displayed-Waiting row (stored `active`) sorts among the other
 * `active` rows again rather than forming its own contiguous block; that
 * capability loss is accepted, not a regression to guard against.
 *
 * The replacement contract this file pins: a status-only sort takes the
 * SINGLE-QUERY DB-paginated path (`findDbPaginatedPage`), not the two-phase
 * candidate-then-hydrate path `findDisplayValueSortedPage` still uses for
 * Duration/Owner — proven by asserting exactly ONE `sessionDetail.findMany`
 * call, with `orderBy` carrying the `artifact.status` relation key.
 */
describe("agentSessionsService status sort (ISS-9939 / ISS-10262)", () => {
  it("issues a SINGLE findMany call ordered on the artifact.status relation, ASC", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
    });

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { sortBy: "status", sortDir: "asc", quality: "all" },
    });

    // ONE call — not the candidate scan + id-hydrate pair the display-value
    // path issues. Two calls here would mean status silently fell back onto
    // the in-memory path this change was meant to retire.
    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0]?.[0] as {
      orderBy?: unknown[];
    };
    expect(args.orderBy?.[0]).toEqual({ artifact: { status: "asc" } });
  });

  it("orders DESC when requested, still a single call", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
    });

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { sortBy: "status", sortDir: "desc", quality: "all" },
    });

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0]?.[0] as {
      orderBy?: unknown[];
    };
    expect(args.orderBy?.[0]).toEqual({ artifact: { status: "desc" } });
  });
});
