import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, expect, it, vi } from "vitest";
import {
  buildSessionListRecord,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";
import { SESSION_COST_RECONCILE_CANDIDATE_CAP } from "./list-page-fetch";

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

// FEA-4297/FEA-4300: the display-value sort path (Duration/Owner) fetches a
// bounded candidate set, orders it IN MEMORY against the exact rendered value,
// then hydrates the page ids. These integration tests drive `findSessions`
// end-to-end and assert the emitted item order, proving the ordering follows the
// DISPLAYED value (not a divergent DB column) and paginates deterministically.
describe("agentSessionsService display-value sort path (duration/user)", () => {
  const START = new Date("2026-05-20T17:00:00.000Z");
  const MINUTE_MS = 60_000;
  const HOUR_MS = 3_600_000;

  function candidate(
    artifactId: string,
    opts: {
      // ISS-5131: the Duration a TERMINAL row displays is `endedAt - startedAt`.
      // `null`/omitted means no end instant at all, which the cell renders blank.
      durationMs?: number | null;
      // Carried so a fixture can prove the comparator IGNORES it: the collector
      // headline is no longer the sort key.
      wallClock?: string | null;
      user?: {
        firstName: string | null;
        lastName: string | null;
        email: string;
      } | null;
    }
  ) {
    const end =
      opts.durationMs === undefined || opts.durationMs === null
        ? null
        : new Date(START.getTime() + opts.durationMs);
    return {
      artifactId,
      sessionStartedAt: START,
      sessionEndedAt: end,
      awaitingInputSince: null,
      artifact: { status: SESSION_STATUS.INACTIVE },
      wallClock: opts.wallClock ?? null,
      user: opts.user ?? null,
    };
  }

  // The display-value path fetches a candidate set, orders it in memory, then
  // hydrates the page ids via a `WHERE id IN` query. The candidate scan selects
  // the display-sort columns (no id `IN` clause); discriminate on the id clause
  // so the wiring is call-order-independent and each `findSessions` invocation
  // gets a fresh candidate scan.
  function installDisplaySortDb(
    candidates: ReturnType<typeof candidate>[],
    fullRowsById: Map<string, Record<string, unknown>>,
    options: { reverseHydrate?: boolean } = {}
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
        // Optionally reverse so the test proves the service re-orders the hydrate
        // result to the reconciled page order (a `WHERE id IN` does not preserve
        // input order).
        return Promise.resolve(options.reverseHydrate ? rows.reverse() : rows);
      });
    installDb({
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(3) },
    });
    return findMany;
  }

  it("orders duration ASC by the DISPLAYED span (FEA-4297)", async () => {
    const candidates = [
      candidate("d-37m48s", { durationMs: 2268 * 1000 }),
      candidate("d-1s", { durationMs: 1000 }),
      candidate("d-4s", { durationMs: 4000 }),
    ];
    const fullRows = new Map(
      candidates.map((c) => [
        c.artifactId,
        buildSessionListRecord({ artifactId: c.artifactId }),
      ])
    );
    installDisplaySortDb(candidates, fullRows, { reverseHydrate: true });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { sortBy: "duration", sortDir: "asc", quality: "all" },
    });

    expect(result.items.map((item) => item.id)).toEqual([
      "d-1s",
      "d-4s",
      "d-37m48s",
    ]);
  });

  it("ISS-5131: floats a BLANK-Duration row to the end of a DESC duration sort", async () => {
    // A terminal row with no end instant has nothing to measure, so its cell is
    // blank and it must collect with the blanks rather than rank as a 0 among
    // the real minima.
    const candidates = [
      candidate("d-blank", { durationMs: null }),
      candidate("d-max", { durationMs: 2268 * 1000 }),
      candidate("d-mid", { durationMs: 4000 }),
    ];
    const fullRows = new Map(
      candidates.map((c) => [
        c.artifactId,
        buildSessionListRecord({ artifactId: c.artifactId }),
      ])
    );
    installDisplaySortDb(candidates, fullRows);

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { sortBy: "duration", sortDir: "desc", quality: "all" },
    });

    expect(result.items.map((item) => item.id)).toEqual([
      "d-max",
      "d-mid",
      "d-blank",
    ]);
  });

  // ISS-5131: these fixtures set a `wallClock` whose order is the REVERSE of the
  // rows' real spans, so a comparator that regressed to keying on the collector
  // headline emits the exact opposite of each expectation below.
  it("orders duration ASC by the session's own span, NOT the collector wallClock", async () => {
    const candidates = [
      candidate("d-min", { durationMs: HOUR_MS, wallClock: "9h" }),
      candidate("d-max", {
        durationMs: 4 * HOUR_MS + 54 * MINUTE_MS,
        wallClock: "1h",
      }),
      candidate("d-mid", { durationMs: 2 * HOUR_MS, wallClock: "5h" }),
    ];
    const fullRows = new Map(
      candidates.map((c) => [
        c.artifactId,
        buildSessionListRecord({
          artifactId: c.artifactId,
          wallClock: c.wallClock,
        }),
      ])
    );
    installDisplaySortDb(candidates, fullRows);

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { sortBy: "duration", sortDir: "asc", quality: "all" },
    });

    // A wallClock-keyed comparator would emit the exact reverse.
    expect(result.items.map((item) => item.id)).toEqual([
      "d-min",
      "d-mid",
      "d-max",
    ]);
  });

  it("orders duration DESC by the session's own span", async () => {
    const candidates = [
      candidate("d-min", { durationMs: HOUR_MS, wallClock: "9h" }),
      candidate("d-max", {
        durationMs: 4 * HOUR_MS + 54 * MINUTE_MS,
        wallClock: "1h",
      }),
    ];
    const fullRows = new Map(
      candidates.map((c) => [
        c.artifactId,
        buildSessionListRecord({
          artifactId: c.artifactId,
          wallClock: c.wallClock,
        }),
      ])
    );
    installDisplaySortDb(candidates, fullRows);

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { sortBy: "duration", sortDir: "desc", quality: "all" },
    });

    expect(result.items.map((item) => item.id)).toEqual(["d-max", "d-min"]);
  });

  it("orders a row carrying NO wallClock on the same scale as the rest", async () => {
    // An older Desktop build omits `wallClock` entirely. Under the ISS-5131 rule
    // that changes nothing — every row is measured from its own bounds — so the
    // legacy row interleaves rather than floating out.
    const candidates = [
      candidate("d-2h", { durationMs: 2 * HOUR_MS, wallClock: "10m" }),
      candidate("legacy-1h", { durationMs: HOUR_MS }),
      candidate("d-30m", { durationMs: 30 * MINUTE_MS, wallClock: "3h" }),
    ];
    const fullRows = new Map(
      candidates.map((c) => [
        c.artifactId,
        buildSessionListRecord({
          artifactId: c.artifactId,
          wallClock: c.wallClock,
        }),
      ])
    );
    installDisplaySortDb(candidates, fullRows);

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { sortBy: "duration", sortDir: "asc", quality: "all" },
    });

    expect(result.items.map((item) => item.id)).toEqual([
      "d-30m",
      "legacy-1h",
      "d-2h",
    ]);
  });

  it("orders owner ASC by the DISPLAYED name even when it disagrees with email order (FEA-4300)", async () => {
    // Name order Ada < Zed; email order is the reverse. The sort must follow the
    // rendered display name, not the hidden email.
    const candidates = [
      candidate("row-zed", {
        durationMs: 1000,
        user: {
          firstName: "Zed",
          lastName: "Young",
          email: "aaa@example.com",
        },
      }),
      candidate("row-ada", {
        durationMs: 1000,
        user: {
          firstName: "Ada",
          lastName: "Lovelace",
          email: "zzz@example.com",
        },
      }),
    ];
    const fullRows = new Map(
      candidates.map((c) => [
        c.artifactId,
        buildSessionListRecord({
          artifactId: c.artifactId,
          user: {
            id: c.artifactId,
            email: c.user?.email,
            firstName: c.user?.firstName,
            lastName: c.user?.lastName,
            avatarUrl: null,
          },
        }),
      ])
    );
    installDisplaySortDb(candidates, fullRows);

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { sortBy: "user", sortDir: "asc", quality: "all" },
    });

    expect(result.items.map((item) => item.id)).toEqual(["row-ada", "row-zed"]);
  });

  it("paginates deterministically under tied durations via the unique tiebreaker (FEA-4329)", async () => {
    // Two rows with the SAME duration must resolve to a stable order (artifactId
    // desc) so an offset page can neither skip nor repeat a row.
    const candidates = [
      candidate("aaa", { durationMs: 5000 }),
      candidate("bbb", { durationMs: 5000 }),
    ];
    const fullRows = new Map(
      candidates.map((c) => [
        c.artifactId,
        buildSessionListRecord({ artifactId: c.artifactId }),
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
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(2) },
    });

    // First page (limit 1) → the tiebreaker winner; second page → the other.
    const page1 = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {
        sortBy: "duration",
        sortDir: "asc",
        limit: 1,
        offset: 0,
        quality: "all",
      },
    });
    const page2 = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {
        sortBy: "duration",
        sortDir: "asc",
        limit: 1,
        offset: 1,
        quality: "all",
      },
    });

    // No row skipped or repeated across the two offset pages.
    expect(page1.items.map((item) => item.id)).toEqual(["bbb"]);
    expect(page2.items.map((item) => item.id)).toEqual(["aaa"]);
  });

  it("reports total as the SIZE of the ordered (bounded) candidate set, not an uncapped count (thread #2/#5)", async () => {
    // The in-memory sort can only order what the bounded candidate scan
    // materialized. `total` must equal that ordered population so pagination never
    // advertises pages past the last orderable row. Here the candidate scan yields
    // 3 rows while a stale `count(where)` mock claims 999_999 — `total` must be 3,
    // NOT 999_999, so `offset >= 3` never promises a page that resolves empty.
    const candidates = [
      candidate("d-1", { durationMs: 1000 }),
      candidate("d-2", { durationMs: 2000 }),
      candidate("d-3", { durationMs: 3000 }),
    ];
    const fullRows = new Map(
      candidates.map((c) => [
        c.artifactId,
        buildSessionListRecord({ artifactId: c.artifactId }),
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
      // A deliberately-inflated count that the display-value path must NOT trust.
      sessionDetail: { findMany, count: vi.fn().mockResolvedValue(999_999) },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { sortBy: "duration", sortDir: "asc", quality: "all" },
    });

    expect(result.total).toBe(3);
    expect(result.items.map((item) => item.id)).toEqual(["d-1", "d-2", "d-3"]);
  });

  it("resolves idleCount from ONE capped aggregate, never a row materialization (ISS-6053)", async () => {
    // Nothing on this path consumes the idle rows — only their number — so the
    // idle read is a `count`, and the candidate cap rides IN that aggregate as
    // a `take` rather than clamping its answer afterwards. The mock below is
    // faithful to what `take` compiles to (`COUNT(*) FROM (SELECT … LIMIT n)`),
    // so an unbounded `count` would surface the raw over-cap population here.
    // A regression back to a `findMany` shows up as a third read.
    const candidates = [candidate("d-1", { durationMs: 1000 })];
    const fullRow = buildSessionListRecord({ artifactId: "d-1" });
    const findMany = vi
      .fn()
      .mockImplementation((args: { where: { AND?: unknown[] } }) => {
        const idClause = (args.where.AND?.[1] ?? {}) as {
          artifactId?: { in?: string[] };
        };
        return Promise.resolve(
          idClause.artifactId?.in === undefined ? candidates : [fullRow]
        );
      });
    const overCap = SESSION_COST_RECONCILE_CANDIDATE_CAP + 2345;
    const count = vi
      .fn()
      .mockImplementation((args: { take?: number; where?: unknown }) =>
        Promise.resolve(
          Math.min(overCap, args.take ?? Number.POSITIVE_INFINITY)
        )
      );
    installDb({ sessionDetail: { findMany, count } });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      // `substantive` is what makes the service build an idleWhere at all.
      filters: { sortBy: "duration", sortDir: "asc", quality: "substantive" },
    });

    // The db is mocked here, so what this pins is the CALL the service makes:
    // the cap rides in the aggregate as `take`, and the aggregate is scoped to
    // the idle complement — never to the substantive population the list
    // itself shows, which would report a foreign number as `idleCount`.
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({ take: SESSION_COST_RECONCILE_CANDIDATE_CAP })
    );
    const countedWhere = JSON.stringify(count.mock.calls[0]?.[0].where);
    expect(countedWhere).toContain('"lte":0');
    expect(countedWhere).not.toContain('"gt":0');
    expect(result.idleCount).toBe(SESSION_COST_RECONCILE_CANDIDATE_CAP);
    expect(count).toHaveBeenCalledTimes(1);
    // Candidate scan + page hydrate only: no third read for the idle rows.
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});
