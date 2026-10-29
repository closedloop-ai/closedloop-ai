// Shared DB-mock harness for the Sessions cost-reconciliation test suites
// (FEA-4276 reconciliation + FEA-4293/4294 usage-summary↔table parity). Extracted
// so the two suites stay under the 1,000-line file ceiling while driving
// `findSessions` / `buildUsageSummaryWhere` through the SAME candidate/`$queryRaw`
// mock wiring. Each test file keeps its own hoisted `vi.mock("@repo/database", …)`
// / telemetry mocks (module mocks are per-file); this module owns the fixture
// shape and the `installCostSessions` wiring they share.

import { SESSION_STATUS } from "@repo/api/src/types/session-status";
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
  /**
   * ISS-8335: the DB-native sort columns, so a fixture can exercise a cost rule
   * composed with a `harness`/`model`/`repo` rule. Omitted, every row shares one
   * value and the column decides nothing — which is what keeps the existing
   * cost/duration/owner cases about the column they name.
   */
  harness?: string;
  model?: string | null;
  repositoryFullName?: string | null;
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

/**
 * Wire the DB mocks so `findSessions` reads the cost-filtered candidate
 * population. `sessionDetail.findMany` serves narrow display-sort candidates
 * and full list rows for page hydration; `nameOverride` distinguishes the
 * full select from the candidate select.
 */
/**
 * The `estimated_cost` bounds a `where` carries, if any.
 *
 * ISS-7176: a cost bucket is a DATABASE predicate now, so this harness has to
 * apply it. It did not before — the reconciled path re-derived every candidate's
 * cost and re-bucketed in memory, so returning the whole population here was
 * correct and the in-memory pass did the excluding.
 *
 * Deliberately narrow: it reads only the numeric `estimatedCost` range clauses,
 * which is the one predicate these suites vary. Anything else in the `where`
 * (org scope, quality, date window) is composed by code that has its own tests;
 * modelling all of Prisma here would be building a database to test a filter.
 */
function estimatedCostBounds(
  where: unknown
): { gte?: number; lt?: number } | null {
  let found: { gte?: number; lt?: number } | null = null;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) {
        walk(entry);
      }
      return;
    }
    if (node === null || typeof node !== "object") {
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "estimatedCost" && value && typeof value === "object") {
        const bound = value as { gte?: unknown; lt?: unknown };
        if (typeof bound.gte === "number" || typeof bound.lt === "number") {
          found = {
            ...(typeof bound.gte === "number" ? { gte: bound.gte } : {}),
            ...(typeof bound.lt === "number" ? { lt: bound.lt } : {}),
          };
          return;
        }
      }
      walk(value);
    }
  };
  walk(where);
  return found;
}

export function installCostSessions(sessions: FakeSession[]): void {
  /** The fixture rows a `where`'s cost bounds admit — the database's job now. */
  const admitted = (where: unknown): FakeSession[] => {
    const bounds = estimatedCostBounds(where);
    if (bounds === null) {
      return sessions;
    }
    return sessions.filter(
      (session) =>
        (bounds.gte === undefined || session.storedRollup >= bounds.gte) &&
        (bounds.lt === undefined || session.storedRollup < bounds.lt)
    );
  };
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

  const findMany = vi
    .fn()
    .mockImplementation(
      (args: { select?: { nameOverride?: true }; where?: unknown }) => {
        // Hydrate call: the FULL list select. Discriminated on
        // `nameOverride`, a field only `agentSessionListSelect` carries.
        //
        // It used to test `harness`, which ISS-8335 broke by adding the
        // DB-native sort columns to `displaySortCandidateSelect` so a multi-rule
        // chain could order them in memory. The candidate scan then also asked
        // for `harness`, fell into THIS branch, and every cost-composed sort
        // silently received full list rows in fixture order — the tests read as
        // an ordering regression when the ordering was never reached. Pick a
        // discriminator the candidate select has no reason to grow into. D5
        // added `externalSessionId` to the candidate, so it no longer qualifies.
        if (args.select?.nameOverride) {
          const idFilter = extractIdInFilter(args.where);
          const rows = (
            idFilter ?? admitted(args.where).map((s) => s.artifactId)
          )
            .map((id) => listRowById.get(id))
            .filter((row): row is NonNullable<typeof row> => row !== undefined);
          return Promise.resolve(rows);
        }
        // Candidate scan: narrow select with the display-sort columns. The
        // display keys let a cost-bucket filter compose with Owner/Duration
        // ordering (thread #1/#4).
        return Promise.resolve(
          admitted(args.where).map((s) => ({
            artifactId: s.artifactId,
            computeTargetId: null,
            externalSessionId: s.artifactId,
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
            // ISS-12251 D-1: the Owner sort reads the artifact's assignee.
            artifact: {
              status: SESSION_STATUS.INACTIVE,
              assignee: s.user ?? null,
            },
            // ISS-8335: the DB-native sort columns the candidate select now
            // carries, so a cost rule composed with a `repo`/`harness`/`model`
            // rule has something to order by. Fixed values unless a fixture
            // opts in — a fixture that varied them by default would let a
            // column no test named decide an assertion.
            harness: s.harness ?? "claude",
            model: s.model ?? null,
            repositoryFullName: s.repositoryFullName ?? null,
          }))
        );
      }
    );

  installDb({
    sessionDetail: {
      findMany,
      // ISS-7176: the TOTAL obeys the cost predicate too. It used to be the raw
      // population size, which was right when the cost bucket was applied in
      // memory after the count — the page's `total` came from the reconciled
      // survivors, not from this call. Now the database counts what it filters,
      // so a fixture's `total` must move with the bucket or every composition
      // case reads the unfiltered population as its denominator.
      count: vi
        .fn()
        .mockImplementation((args?: { where?: unknown }) =>
          Promise.resolve(admitted(args?.where).length)
        ),
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
