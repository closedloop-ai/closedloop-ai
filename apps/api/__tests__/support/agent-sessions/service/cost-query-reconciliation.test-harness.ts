// Shared DB-mock harness for the Sessions cost-reconciliation test suites
// (FEA-4276 reconciliation + FEA-4293/4294 usage-summary↔table parity). Extracted
// so the two suites stay under the 1,000-line file ceiling while driving
// `findSessions` / `buildUsageSummaryWhere` through the SAME candidate/`$queryRaw`
// mock wiring. Each test file keeps its own hoisted `vi.mock("@repo/database", …)`
// / telemetry mocks (module mocks are per-file); this module owns the fixture
// shape and the `installCostSessions` wiring they share.

import { vi } from "vitest";
import { buildSessionListRecord, installDb } from "../service.test-harness";

export type FakeSession = {
  artifactId: string;
  /** Stale stored rollup — what the buggy path would filter/sort on. */
  storedRollup: number;
  /** Σ of the (repriced) per-event token costs — the reconciled authority. */
  eventCostSum: number;
  /** Per-event row count (0 → no stream → falls back to the rollup). */
  eventCount: number;
  /**
   * How many of those rows were PRICED (`estimatedCost > 0`). Defaults to
   * `eventCount` (fully priced). When `< eventCount`, the stream is unpriced/mixed
   * and the reconciled cost must fall back to the rollup (FEA-4276 completeness).
   */
  pricedCount?: number;
  /**
   * FEA-4276 (shafty review): the desktop rollup's authoritative input+output
   * token total, the completeness reference. Defaults to `eventTokenSum` so a
   * fixture is a COMPLETE stream unless it opts into a drop. When
   * `rollupTokenTotal > eventTokenSum` the per-event stream is short (a
   * dropped/overflowed ingest chunk) and the reconciled cost falls back to the
   * rollup.
   */
  rollupTokenTotal?: number;
  /**
   * FEA-4276 (shafty review): Σ of the observed per-event input+output token
   * counts. Defaults to a nonzero total that matches `rollupTokenTotal` (a
   * complete stream), so existing per-event-authority cases keep trusting the sum.
   */
  eventTokenSum?: number;
  sessionUpdatedAt: Date;
  /**
   * thread #1/#4: display-sort columns, present when a cost-bucket filter is
   * composed with an Owner/Duration sort so the candidate scan can order the
   * survivors by the displayed value. `sessionStartedAt` defaults to
   * `sessionUpdatedAt` (a real start); `sessionEndedAt` sets the duration span.
   */
  sessionStartedAt?: Date;
  sessionEndedAt?: Date | null;
  lastActivityAt?: Date | null;
  /**
   * ISS-4675: the collector's observed-running Duration headline. When present,
   * this — not the calendar span above — is the value the Duration cell renders
   * AND the value the duration comparator keys on, so a cost-bucket filter
   * composed with a duration sort must carry it through the candidate narrowing.
   */
  wallClock?: string | null;
  user?: {
    firstName: string | null;
    lastName: string | null;
    email: string;
  } | null;
  /**
   * The session's billing mode. A subscription mode keeps a $0 cost KNOWN (the
   * cell shows a real `$0.00` figure) so it still participates in numeric buckets
   * and sorts as a value; any other value (or the default `null`) leaves a $0
   * cost UNKNOWN (renders `—`), excluded from numeric buckets and sorted last
   * (FEA-4294 + shafty cost-blanks-last thread).
   */
  billingMode?: string | null;
  /** Token counts on the FULL list row so the cell derives availability. */
  inputTokens?: number;
  outputTokens?: number;
  /**
   * ISS-4481: substantive-work signals the numeric-vs-unknown boundary gates on
   * (mirroring `deriveCostAvailability`'s measurable-work-first ordering). A
   * subscription $0 session only shows a `$0.00` figure — and only participates in
   * numeric buckets — when it did measurable work; a no-work subscription session
   * renders `—` (Unknown). Default `turns` to 1 so a fixture is a WORKED session
   * unless it opts into a zero-work state. `toolUseCount` defaults to 0.
   */
  turns?: number;
  toolUseCount?: number;
};

/** A fixture's complete-stream token total when it doesn't override one. */
export const DEFAULT_TOKEN_TOTAL = 1000;

export const UNDER_1_BUCKET = "under_1";
export const FROM_50_BUCKET = "from_50";

/** The rollup token total a fixture exposes (defaults to a complete stream). */
function rollupTokensOf(session: FakeSession): number {
  if (session.rollupTokenTotal !== undefined) {
    return session.rollupTokenTotal;
  }
  return session.eventCount > 0 ? DEFAULT_TOKEN_TOTAL : 0;
}

/** The per-event token sum a fixture exposes (defaults to a complete stream). */
function eventTokensOf(session: FakeSession): number {
  if (session.eventTokenSum !== undefined) {
    return session.eventTokenSum;
  }
  return session.eventCount > 0 ? DEFAULT_TOKEN_TOTAL : 0;
}

/** The `$queryRaw` mock the current `installCostSessions` wired, for SQL asserts. */
let capturedQueryRaw: ReturnType<typeof vi.fn> | null = null;

/** The `$queryRaw` mock the most recent `installCostSessions` wired (or null). */
export function getCapturedQueryRaw(): ReturnType<typeof vi.fn> | null {
  return capturedQueryRaw;
}

/** Reset the captured `$queryRaw` and `findMany` mocks between tests. */
export function resetCapturedQueryRaw(): void {
  capturedQueryRaw = null;
  capturedFindMany = null;
}

/** The `sessionDetail.findMany` mock the current `installCostSessions` wired. */
let capturedFindMany: ReturnType<typeof vi.fn> | null = null;

/** The `sessionDetail.findMany` mock the most recent `installCostSessions` wired. */
export function getCapturedFindMany(): ReturnType<typeof vi.fn> | null {
  return capturedFindMany;
}

/**
 * The `orderBy` the candidate scan was invoked with (the narrow-select
 * `findMany` call that DOESN'T ask for the full-list `harness` column). Returns
 * the FIRST such call's `orderBy`, or null if no candidate scan ran. This is the
 * ordering that decides WHICH rows survive the `SESSION_COST_RECONCILE_CANDIDATE_CAP`
 * — the seam wongk flagged for table↔export/summary divergence (FEA-4326).
 */
export function getCandidateScanOrderBy(): unknown {
  const calls = capturedFindMany?.mock.calls ?? [];
  for (const [args] of calls) {
    if (!(args as { select?: { harness?: true } }).select?.harness) {
      return (args as { orderBy?: unknown }).orderBy;
    }
  }
  return null;
}

/**
 * Wire the DB mocks so `findSessions` reads `sessions` as its candidate
 * population and reconciles each one from the per-event aggregate. The
 * `sessionDetail.findMany` mock serves narrow candidate rows for the
 * cost-reconciliation scan and full list rows for the page hydrate (branched on
 * whether the select asked for `harness`, a full-list-only column).
 */
export function installCostSessions(sessions: FakeSession[]): void {
  const listRowById = new Map(
    sessions.map((s) => [
      s.artifactId,
      buildSessionListRecord({
        artifactId: s.artifactId,
        estimatedCost: s.storedRollup,
        // The rollup token total is split across input/output; only the sum
        // matters to the completeness cross-check.
        inputTokens: s.inputTokens ?? rollupTokensOf(s),
        outputTokens: s.outputTokens ?? 0,
        sessionUpdatedAt: s.sessionUpdatedAt,
        billingMode: s.billingMode ?? null,
        wallClock: s.wallClock ?? null,
        ...(s.user
          ? {
              user: {
                id: s.artifactId,
                email: s.user.email,
                firstName: s.user.firstName,
                lastName: s.user.lastName,
                avatarUrl: null,
              },
            }
          : {}),
      }),
    ])
  );

  const queryRaw = vi.fn().mockResolvedValue(
    sessions
      .filter((s) => s.eventCount > 0)
      .map((s) => ({
        agentSessionId: s.artifactId,
        eventCount: BigInt(s.eventCount),
        pricedCount: BigInt(s.pricedCount ?? s.eventCount),
        costSum: s.eventCostSum,
        tokenSum: BigInt(eventTokensOf(s)),
      }))
  );
  capturedQueryRaw = queryRaw;

  const findMany = vi
    .fn()
    .mockImplementation(
      (args: { select?: { harness?: true }; where?: unknown }) => {
        // Hydrate call: full list select (asks for `harness`). Return the list
        // rows for the requested page-id set, order-agnostic (the service
        // re-orders by the reconciled page order).
        if (args.select?.harness) {
          const idFilter = extractIdInFilter(args.where);
          const rows = (idFilter ?? sessions.map((s) => s.artifactId))
            .map((id) => listRowById.get(id))
            .filter((row): row is NonNullable<typeof row> => row !== undefined);
          return Promise.resolve(rows);
        }
        // Candidate scan: narrow select (id + rollup + rollup tokens +
        // updatedAt + the display-sort columns). The rollup token total feeds
        // the completeness cross-check; split across input/output (only the
        // sum matters). The display columns let a cost-bucket filter compose
        // with an Owner/Duration sort (thread #1/#4).
        return Promise.resolve(
          sessions.map((s) => ({
            artifactId: s.artifactId,
            estimatedCost: s.storedRollup,
            inputTokens: s.inputTokens ?? rollupTokensOf(s),
            outputTokens: s.outputTokens ?? 0,
            // ISS-4481: the candidate carries the substantive-work counts so the
            // reconciled numeric-vs-unknown gate reads the same measurable-work
            // signal the Cost cell does. `turns` defaults to 1 (a worked session)
            // unless the fixture opts into a no-work state.
            turns: s.turns ?? 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            toolUseCount: s.toolUseCount ?? 0,
            sessionUpdatedAt: s.sessionUpdatedAt,
            billingMode: s.billingMode ?? null,
            sessionStartedAt: s.sessionStartedAt ?? s.sessionUpdatedAt,
            sessionEndedAt: s.sessionEndedAt ?? null,
            lastActivityAt: s.lastActivityAt ?? null,
            wallClock: s.wallClock ?? null,
            user: s.user ?? null,
          }))
        );
      }
    );
  capturedFindMany = findMany;

  installDb({
    sessionDetail: {
      findMany,
      count: vi.fn().mockResolvedValue(sessions.length),
    },
    // FEA-4276: the reconciled-cost reader is ONE bounded, org-scoped raw
    // aggregate (`$queryRaw`) returning { agentSessionId, eventCount, pricedCount,
    // costSum, tokenSum } per session with per-event rows. bigints mirror Postgres
    // COUNT(*)/SUM(bigint). `tokenSum` is the completeness cross-check.
    $queryRaw: queryRaw,
  });
}

/** Pull the `artifactId: { in: [...] }` id set out of a (possibly AND-wrapped) where. */
export function extractIdInFilter(where: unknown): string[] | null {
  if (!where || typeof where !== "object") {
    return null;
  }
  const record = where as {
    AND?: unknown[];
    artifactId?: { in?: string[] };
  };
  if (record.artifactId?.in) {
    return record.artifactId.in;
  }
  for (const clause of record.AND ?? []) {
    const nested = clause as { artifactId?: { in?: string[] } };
    if (nested.artifactId?.in) {
      return nested.artifactId.in;
    }
  }
  return null;
}

export const UPDATED = (minute: number): Date =>
  new Date(`2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`);
