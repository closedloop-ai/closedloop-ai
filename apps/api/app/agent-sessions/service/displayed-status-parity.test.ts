import { analytics } from "@repo/analytics/server";
import {
  DISPLAYED_STATUS_PARITY_CASES,
  type DisplayedStatusParityCase,
} from "@repo/api/src/agent-session-displayed-status-parity.test-fixtures";
import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
  STALE_SESSION_DISPLAY_THRESHOLD_HOURS,
} from "@repo/api/src/types/session-status";
import { SESSIONS_DISPLAYED_STATUS_PARITY_FLAG_KEY } from "@repo/api/src/types/sessions-displayed-status-parity-flag";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installDb } from "@/__tests__/support/agent-sessions/service.test-harness";
import {
  clearDisplayedStatusParityDecisions,
  DISPLAYED_STATUS_PARITY_DECISION_MAX_ENTRIES,
  DISPLAYED_STATUS_PARITY_DECISION_TTL_MS,
  DISPLAYED_STATUS_PARITY_UNAVAILABLE_BACKOFF_MS,
  resolveDisplayedStatusParity,
} from "../route-helpers";
import { agentSessionsService } from "../service";
import { projectDisplayedSessionStatus } from "./session-status-projection";

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

vi.mock("@repo/analytics/server", () => ({
  analytics: { isFeatureEnabled: undefined },
}));

const CLERK_USER_ID = "user_clerk_1";
const AWAITING_AT = new Date("2026-01-01T01:30:00.000Z");
const ENDED_AT = new Date("2026-01-01T02:00:00.000Z");

type ParityRecord = {
  status: string;
  awaitingInputSince: Date | null;
  sessionEndedAt: Date | null;
  lastActivityAt: Date | null;
  sessionStartedAt: Date | null;
};

function toRecord(parityCase: DisplayedStatusParityCase): ParityRecord {
  return {
    status: parityCase.rawStatus,
    awaitingInputSince: parityCase.awaitingInput ? AWAITING_AT : null,
    sessionEndedAt: parityCase.ended ? ENDED_AT : null,
    // ISS-4556: the staleness anchor is driven by the oracle, not pinned fresh.
    // The ACTIVE and STALE predicates disagree ONLY on this dimension, so a table
    // that held every row inside the window was blind by construction to the gap
    // between them. Both instants are RELATIVE to now — a fixed past date would
    // turn every row Stale as wall-clock time passed.
    lastActivityAt: parityCase.staleAnchor ? staleAnchorAt() : new Date(),
    sessionStartedAt: parityCase.staleAnchor ? staleAnchorAt() : new Date(),
  };
}

/**
 * An activity instant OUTSIDE the display staleness window, derived from the
 * shared cutoff so a change to the threshold cannot leave these fixtures on the
 * wrong side of it. Computed per call, never at module load, so a long test run
 * cannot age it into or out of the window.
 */
function staleAnchorAt(): Date {
  return new Date(
    Date.now() - (STALE_SESSION_DISPLAY_THRESHOLD_HOURS + 1) * 60 * 60 * 1000
  );
}

/**
 * ISS-4556: the interpreter is THREE-valued, because SQL is.
 *
 * `null` here is SQL NULL — "neither true nor false" — and it is not a pedantic
 * distinction: `lastActivityAt` is a nullable column, so a bare
 * `last_activity_at < $cutoff` is NULL for a null row, and the ACTIVE facet
 * NEGATES that disjunction. `NOT NULL` is NULL, which `WHERE` rejects, so the row
 * is returned by neither Active nor Stale. Modeling a null column as plain
 * `false` — which this interpreter used to do — makes the negation come out
 * `true` and hides exactly that class of invisible row, which is the class this
 * whole batch exists to close.
 */
type SqlBoolean = boolean | null;

/** SQL `AND`: false wins over NULL, NULL wins over true. */
function sqlAnd(values: SqlBoolean[]): SqlBoolean {
  if (values.includes(false)) {
    return false;
  }
  return values.includes(null) ? null : true;
}

/** SQL `OR`: true wins over NULL, NULL wins over false. */
function sqlOr(values: SqlBoolean[]): SqlBoolean {
  if (values.includes(true)) {
    return true;
  }
  return values.includes(null) ? null : false;
}

/** SQL `NOT`: NULL stays NULL. */
function sqlNot(value: SqlBoolean): SqlBoolean {
  return value === null ? null : !value;
}

/**
 * Evaluate one emitted Prisma clause against a plain record.
 *
 * The Status facet's whole job is deciding membership, so this test EXECUTES that
 * decision instead of asserting the clause's shape — a shape assertion passes
 * just as happily on a predicate that returns the wrong rows, which is precisely
 * how ISS-4559 survived the existing FEA-3035 shape tests. Only the clause
 * vocabulary `buildStatusFacetPredicate` actually emits is interpreted; anything
 * else throws so a future predicate shape cannot silently evaluate to `true`.
 */
function evaluateClause(clause: unknown, record: ParityRecord): SqlBoolean {
  if (typeof clause !== "object" || clause === null) {
    throw new Error(`unsupported clause: ${JSON.stringify(clause)}`);
  }
  return sqlAnd(
    Object.entries(clause).map(([key, value]) =>
      evaluateClauseEntry(key, value, record)
    )
  );
}

function evaluateClauseEntry(
  key: string,
  value: unknown,
  record: ParityRecord
): SqlBoolean {
  if (key === "OR") {
    return sqlOr((value as unknown[]).map((e) => evaluateClause(e, record)));
  }
  if (key === "AND") {
    return sqlAnd((value as unknown[]).map((e) => evaluateClause(e, record)));
  }
  if (key === "NOT") {
    // ISS-4556: the GROUPED reading, `NOT(a AND b)`. Not an assumption — Prisma
    // 7.8 was run against real Postgres with a two-key `NOT` and emits
    // `NOT ("awaitingInputSince" IS NOT NULL AND "sessionEndedAt" IS NULL)`,
    // returning the same rows as the explicit disjunction. The predicates under
    // test no longer depend on it either way: `DOES_NOT_DISPLAY_AS_WAITING`
    // spells the disjunction out, so this branch only serves the single-key
    // staleness `NOT` below.
    return sqlNot(evaluateClause(value, record));
  }
  if (key === "artifact") {
    return evaluateStatusClause(
      (value as { is: { status: unknown } }).is.status,
      record.status
    );
  }
  if (key === "awaitingInputSince" || key === "sessionEndedAt") {
    return evaluateNullableClause(value, record[key]);
  }
  if (key === "lastActivityAt" || key === "sessionStartedAt") {
    // ISS-5366 staleness anchor branches: `{ lt: cutoff }` or a plain `null`.
    return evaluateAnchorClause(value, record[key]);
  }
  throw new Error(`unsupported clause key: ${key}`);
}

function evaluateStatusClause(status: unknown, actual: string): SqlBoolean {
  if (typeof status === "string") {
    return actual === status;
  }
  const filter = status as { in?: string[]; notIn?: string[] };
  if (filter.in) {
    return filter.in.includes(actual);
  }
  if (filter.notIn) {
    return !filter.notIn.includes(actual);
  }
  throw new Error(`unsupported status clause: ${JSON.stringify(status)}`);
}

function evaluateAnchorClause(value: unknown, actual: Date | null): SqlBoolean {
  if (value === null) {
    // `IS NULL` is two-valued in SQL.
    return actual === null;
  }
  const filter = value as { lt?: Date; not?: unknown };
  const cutoff = filter.lt;
  if (!(cutoff instanceof Date)) {
    throw new Error(`unsupported anchor clause: ${JSON.stringify(value)}`);
  }
  // A comparison against a NULL column is NULL, not false — unless the SAME field
  // filter also carries `not: null`, which Prisma ANDs in as an `IS NOT NULL`
  // guard and makes the whole branch two-valued again. That guard is the fix
  // under test, so the interpreter has to be able to tell the two apart.
  if (actual === null) {
    return Object.hasOwn(filter, "not") && filter.not === null ? false : null;
  }
  return actual.getTime() < cutoff.getTime();
}

function evaluateNullableClause(
  value: unknown,
  actual: Date | null
): SqlBoolean {
  if (value === null) {
    return actual === null;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { not?: unknown }).not === null
  ) {
    return actual !== null;
  }
  throw new Error(`unsupported nullable clause: ${JSON.stringify(value)}`);
}

/**
 * Run the real list read for one Status facet and return whether the predicate it
 * emitted matches the record. Driving `findSessions` (rather than calling
 * `buildStatusFacetPredicate` directly) keeps the assertion on the production
 * wiring: the route's `displayedStatusParity` scope field has to reach the
 * predicate for the ON case to pass.
 */
async function facetMatches(
  facet: string,
  record: ParityRecord,
  displayedStatusParity: boolean
): Promise<boolean> {
  const findMany = vi.fn().mockResolvedValue([]);
  installDb({
    sessionDetail: { findMany, count: vi.fn().mockResolvedValue(0) },
  });

  await agentSessionsService.findSessions({
    organizationId: "org-1",
    displayedStatusParity,
    filters: { status: facet, quality: "all" },
  });

  const where = findMany.mock.calls[0]?.[0].where as {
    AND?: unknown[];
  };
  const clauses = where.AND ?? [];
  if (clauses.length !== 1) {
    // A helper invariant, not an assertion: a single-status filter must emit
    // exactly one AND clause, so anything else means the read changed shape and
    // the evaluation below would be meaningless rather than merely wrong.
    throw new Error(
      `expected one status clause, received ${JSON.stringify(clauses)}`
    );
  }
  // SQL `WHERE` keeps a row only when the predicate is TRUE; NULL is rejected
  // exactly like FALSE.
  return evaluateClause(clauses[0], record) === true;
}

describe("Sessions displayed-status parity (ISS-4556 / ISS-4559)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // ISS-4556: `clearAllMocks` clears call RECORDS, not implementations, so an
    // `isFeatureEnabled` assigned by an earlier test survives into the next one —
    // and the module mock's `undefined` (the "no analytics client configured"
    // path, which is the only way `evaluateFeatureFlagForAnyIdentity` can report
    // UNAVAILABLE without a throw) becomes unreachable after the first
    // assignment. Restore the declared default explicitly. `deleteProperty`
    // rather than assigning `undefined`: that is the state the production guard
    // actually tests (`typeof analytics?.isFeatureEnabled !== "function"`), and
    // it needs no cast to satisfy the PostHog client's non-optional method type.
    Reflect.deleteProperty(analytics, "isFeatureEnabled");
    // The gate memoizes per viewer, so a decision from an earlier test would
    // otherwise satisfy the next one without PostHog being asked at all.
    clearDisplayedStatusParityDecisions();
  });

  for (const parityCase of DISPLAYED_STATUS_PARITY_CASES) {
    it(`projects the displayed status: ${parityCase.name}`, () => {
      expect(projectDisplayedSessionStatus(toRecord(parityCase))).toBe(
        parityCase.displayedStatus
      );
    });

    it(`returns the row from exactly the facet it displays: ${parityCase.name}`, async () => {
      const record = toRecord(parityCase);

      expect(await facetMatches(SESSION_STATUS.ACTIVE, record, true)).toBe(
        parityCase.matchedByActiveFacet
      );
      expect(
        await facetMatches(DISPLAYED_SESSION_STATUS.WAITING, record, true)
      ).toBe(parityCase.matchedByWaitingFacet);
      // ISS-4556: STALE and UNKNOWN are asserted too. ACTIVE subtracts "displays
      // as Waiting" while STALE used the wider "awaiting input", and UNKNOWN
      // matched purely on an unrecognized status — so a sweep over ACTIVE and
      // WAITING alone cannot see a row that falls through both, or one returned
      // by two facets at once.
      expect(
        await facetMatches(DISPLAYED_SESSION_STATUS.STALE, record, true)
      ).toBe(parityCase.matchedByStaleFacet);
      expect(
        await facetMatches(DISPLAYED_SESSION_STATUS.UNKNOWN, record, true)
      ).toBe(parityCase.matchedByUnknownFacet);
      // ISS-4556: the facet named by the row's OWN stored status — the INACTIVE
      // branch for an `inactive` row, the raw-status fallback for a retired or
      // unrecognized one. Without it the four facets above only ever assert
      // `false` for a row displaying Inactive, so nothing here could tell an
      // unreachable row from a correctly-excluded one.
      expect(await facetMatches(parityCase.rawStatus, record, true)).toBe(
        parityCase.matchedByRawStatusFacet
      );
    });
  }

  it("returns a null-lastActivityAt row with a fresh start time from the Active facet", async () => {
    // ISS-4556: `lastActivityAt` is nullable (`DateTime?`, "Nullable for
    // pre-backfill rows; readers fall back to sessionStartedAt"), and the
    // staleness anchor is `lastActivityAt ?? sessionStartedAt` on every other
    // surface. This row's anchor is therefore its FRESH start time, so the
    // projection displays Active and the Active facet must return it.
    //
    // It did not. The anchor's first branch was a bare `lastActivityAt < cutoff`,
    // which is SQL NULL for a null column, and the second branch
    // (`lastActivityAt: null, sessionStartedAt < cutoff`) is false for a fresh
    // start — so the disjunction was `NULL OR FALSE` = NULL. ACTIVE negates it
    // (`NOT NULL` = NULL, rejected by WHERE) and STALE selects it (NULL, also
    // rejected): the row was returned by NEITHER facet while displaying Active,
    // the same invisible-row class as ISS-4559 one column over.
    //
    // Deliberately NOT in the shared oracle: desktop's `last_activity_at` is NOT
    // NULL with an epoch default, so this row cannot exist there and a shared case
    // would assert a shape one surface can never produce.
    const record: ParityRecord = {
      status: SESSION_STATUS.ACTIVE,
      awaitingInputSince: null,
      sessionEndedAt: null,
      lastActivityAt: null,
      sessionStartedAt: new Date(),
    };

    expect(projectDisplayedSessionStatus(record)).toBe(SESSION_STATUS.ACTIVE);
    expect(await facetMatches(SESSION_STATUS.ACTIVE, record, true)).toBe(true);
    expect(
      await facetMatches(DISPLAYED_SESSION_STATUS.STALE, record, true)
    ).toBe(false);
  });

  it("moves a null-lastActivityAt row with a stale start time to the Stale facet", async () => {
    // The other side of the same partition: with no activity timestamp the anchor
    // falls back to the start time, which here IS past the cutoff — so the row
    // badges Stale and belongs to Stale alone. Pinned so a null-safety fix cannot
    // be "achieved" by exempting null-activity rows from staleness altogether,
    // which would restore the confident "Active" ISS-4998 removed.
    const record: ParityRecord = {
      status: SESSION_STATUS.ACTIVE,
      awaitingInputSince: null,
      sessionEndedAt: null,
      lastActivityAt: null,
      sessionStartedAt: staleAnchorAt(),
    };

    expect(projectDisplayedSessionStatus(record)).toBe(
      DISPLAYED_SESSION_STATUS.STALE
    );
    expect(await facetMatches(SESSION_STATUS.ACTIVE, record, true)).toBe(false);
    expect(
      await facetMatches(DISPLAYED_SESSION_STATUS.STALE, record, true)
    ).toBe(true);
  });

  it("leaves the ended + awaiting-input row invisible to BOTH facets when the flag is OFF", async () => {
    // The ISS-4559 defect itself, pinned as the closed-by-default rollout state.
    // Without this the parity assertions above would pass on a predicate that was
    // never actually gated, and flipping the flag off would be untested.
    const record = toRecord({
      name: "ended + awaiting",
      rawStatus: SESSION_STATUS.ACTIVE,
      awaitingInput: true,
      ended: true,
      staleAnchor: false,
      displayedStatus: SESSION_STATUS.ACTIVE,
      matchedByActiveFacet: true,
      matchedByWaitingFacet: false,
      matchedByStaleFacet: false,
      matchedByUnknownFacet: false,
      // Unused by `toRecord` (it reads only the row's shape), but stated
      // truthfully rather than filled in: this row displays Active, so its own
      // status filter is the ACTIVE facet.
      matchedByRawStatusFacet: true,
    });

    expect(await facetMatches(SESSION_STATUS.ACTIVE, record, false)).toBe(
      false
    );
    expect(
      await facetMatches(DISPLAYED_SESSION_STATUS.WAITING, record, false)
    ).toBe(false);
    // ...while it still DISPLAYS as Active, which is what makes it a defect
    // rather than a deliberate exclusion.
    expect(projectDisplayedSessionStatus(record)).toBe(SESSION_STATUS.ACTIVE);
  });

  it("keeps the awaiting-input `stale` row under BOTH facets when the flag is OFF", async () => {
    // ISS-5656, pinned as the closed-by-default rollout state. The oracle case
    // asserts the row leaves the Stale facet with the gate ON — and would pass
    // just as happily on an exclusion applied UNCONDITIONALLY, which is the
    // feature-gated-default trap AGENTS.md names. This is the branch that tells
    // the two apart: OFF, the literal-`stale` arm is the bare equality it has
    // always been, so the row is still double-counted.
    const record = toRecord({
      name: "awaiting-input `stale`",
      rawStatus: DISPLAYED_SESSION_STATUS.STALE,
      awaitingInput: true,
      ended: false,
      staleAnchor: false,
      displayedStatus: DISPLAYED_SESSION_STATUS.WAITING,
      matchedByActiveFacet: false,
      matchedByWaitingFacet: true,
      matchedByStaleFacet: false,
      matchedByUnknownFacet: false,
      matchedByRawStatusFacet: false,
    });

    expect(
      await facetMatches(DISPLAYED_SESSION_STATUS.STALE, record, false)
    ).toBe(true);
    expect(
      await facetMatches(DISPLAYED_SESSION_STATUS.WAITING, record, false)
    ).toBe(true);
    // The projection carries no gate at all, so the badge reads "Waiting" in
    // both states — which is precisely why the Stale match above is the defect
    // and not a second legitimate home for the row.
    expect(projectDisplayedSessionStatus(record)).toBe(
      DISPLAYED_SESSION_STATUS.WAITING
    );
  });

  it("resolves the gate for the Clerk distinct id, not only the internal user id", async () => {
    // A rollout targeted at Clerk ids is the normal case. Asking PostHog only
    // about the internal id would leave the cloud half dark while the desktop
    // Labs toggle flipped on — the exact web/desktop skew the shared key exists
    // to prevent, and invisible from the outside. `isFeatureEnabled` here answers
    // true ONLY for the Clerk id, so a regression to a single-identity lookup
    // fails this test rather than passing on the default-off path.
    const isFeatureEnabled = vi
      .fn()
      .mockImplementation((_flag: string, distinctId: string) =>
        Promise.resolve(distinctId === CLERK_USER_ID)
      );
    vi.mocked(analytics).isFeatureEnabled = isFeatureEnabled;

    const enabled = await resolveDisplayedStatusParity({
      userId: "internal-user-1",
      clerkUserId: CLERK_USER_ID,
    });

    expect(enabled).toBe(true);
    expect(isFeatureEnabled).toHaveBeenCalledWith(
      SESSIONS_DISPLAYED_STATUS_PARITY_FLAG_KEY,
      CLERK_USER_ID
    );
  });

  it("keeps a plain running session in the Active facet with the flag OFF", async () => {
    // Guards the OFF path against over-correction: the gate must change only the
    // awaiting-input rows, not narrow Active generally.
    const record = toRecord({
      name: "running",
      rawStatus: SESSION_STATUS.ACTIVE,
      awaitingInput: false,
      ended: false,
      staleAnchor: false,
      displayedStatus: SESSION_STATUS.ACTIVE,
      matchedByActiveFacet: true,
      matchedByWaitingFacet: false,
      matchedByStaleFacet: false,
      matchedByUnknownFacet: false,
      // Unused by `toRecord` (it reads only the row's shape), but stated
      // truthfully rather than filled in: this row displays Active, so its own
      // status filter is the ACTIVE facet.
      matchedByRawStatusFacet: true,
    });

    expect(await facetMatches(SESSION_STATUS.ACTIVE, record, false)).toBe(true);
  });

  it("resolves the gate ONCE per viewer so the four Sessions reads share one decision", async () => {
    // The list, usage, analytics and export routes are four separate requests.
    // Asking PostHog once per request made the gate per-REQUEST: a timeout on one
    // of them painted summary cards built with the OFF predicate above a table
    // built with the ON one. Four resolves, ONE evaluation.
    const isFeatureEnabled = vi.fn().mockResolvedValue(true);
    vi.mocked(analytics).isFeatureEnabled = isFeatureEnabled;
    const identity = { userId: "internal-user-1", clerkUserId: CLERK_USER_ID };

    const decisions = [
      await resolveDisplayedStatusParity(identity),
      await resolveDisplayedStatusParity(identity),
      await resolveDisplayedStatusParity(identity),
      await resolveDisplayedStatusParity(identity),
    ];

    expect(decisions).toEqual([true, true, true, true]);
    expect(isFeatureEnabled).toHaveBeenCalledTimes(1);
  });

  it("holds the viewer's last decision when an evaluation is unavailable", async () => {
    // The defect this closes: a transient PostHog failure on ONE of the four
    // reads used to resolve to a silent `false`, splitting one page load across
    // two predicates that differ by exactly the awaiting-input rows. The read
    // after the outage must report the SAME cohort as the reads before it.
    const isFeatureEnabled = vi.fn().mockResolvedValue(true);
    vi.mocked(analytics).isFeatureEnabled = isFeatureEnabled;
    const identity = { userId: "internal-user-1", clerkUserId: CLERK_USER_ID };
    const resolvedAt = Date.now();

    expect(await resolveDisplayedStatusParity(identity, resolvedAt)).toBe(true);

    isFeatureEnabled.mockRejectedValue(new Error("posthog unavailable"));
    // Past the memo window, so the outage is actually reached rather than
    // answered from cache.
    const afterTtl = resolvedAt + DISPLAYED_STATUS_PARITY_DECISION_TTL_MS + 1;

    expect(await resolveDisplayedStatusParity(identity, afterTtl)).toBe(true);
    // Three calls, not two: the first read short-circuits on the Clerk id
    // answering `true`, and the second tries BOTH ids because the throw is now
    // caught PER ID. Aborting the loop on the first throw — the old behavior this
    // count used to pin — would skip the internal-id namespace a rollout may
    // equally be targeted at, and would discard any definite answer it gave.
    expect(isFeatureEnabled).toHaveBeenCalledTimes(3);
  });

  it("still fails CLOSED when an evaluation is unavailable and nothing was decided before", async () => {
    // Holding the last decision must not become "default on". A viewer this
    // instance has never resolved gets today's shipped behavior.
    const isFeatureEnabled = vi
      .fn()
      .mockRejectedValue(new Error("posthog unavailable"));
    vi.mocked(analytics).isFeatureEnabled = isFeatureEnabled;

    expect(
      await resolveDisplayedStatusParity({
        userId: "internal-user-cold",
        clerkUserId: "user_clerk_cold",
      })
    ).toBe(false);
  });

  it("treats a RESOLVED-undefined evaluation as unavailable, not as an evaluated OFF", async () => {
    // ISS-4556. The tests above prove the unavailable path with a THROW, and a
    // throw was the only way to reach it — which made the whole mitigation inert
    // for the outage it was built for. posthog-node does not reject when
    // evaluation fails: `isFeatureEnabled` is typed `Promise<boolean | undefined>`
    // and its request-failure path returns `undefined`. A bare `=== true` in
    // `isFeatureFlagEnabledForDistinctId` folded that into a definite `false`, so
    // an outage read as "PostHog says OFF" — and this memo then cached that wrong
    // answer for the full TTL, making it STICKIER than the per-request evaluation
    // it replaced.
    const isFeatureEnabled = vi.fn().mockResolvedValue(true);
    vi.mocked(analytics).isFeatureEnabled = isFeatureEnabled;
    const identity = { userId: "internal-user-1", clerkUserId: CLERK_USER_ID };
    const resolvedAt = Date.now();

    expect(await resolveDisplayedStatusParity(identity, resolvedAt)).toBe(true);

    isFeatureEnabled.mockResolvedValue(undefined);
    const afterTtl = resolvedAt + DISPLAYED_STATUS_PARITY_DECISION_TTL_MS + 1;

    // Held, not flipped. Before the fix this returned `false`.
    expect(await resolveDisplayedStatusParity(identity, afterTtl)).toBe(true);
  });

  it("keeps a definite OFF that came back before a later identity threw", async () => {
    // ISS-4556: the try/catch used to wrap the whole distinct-id loop, so a throw
    // on the SECOND id discarded the real `false` the FIRST had already returned
    // and reported UNAVAILABLE — which holds the previous decision, leaving a
    // viewer whose flag was genuinely just turned off still being served ON.
    const isFeatureEnabled = vi.fn().mockResolvedValue(true);
    vi.mocked(analytics).isFeatureEnabled = isFeatureEnabled;
    const identity = { userId: "internal-user-1", clerkUserId: CLERK_USER_ID };
    const resolvedAt = Date.now();

    expect(await resolveDisplayedStatusParity(identity, resolvedAt)).toBe(true);

    // The Clerk id now answers a definite OFF; the internal id throws.
    isFeatureEnabled.mockImplementation((_flag: string, distinctId: string) => {
      if (distinctId === CLERK_USER_ID) {
        return Promise.resolve(false);
      }
      return Promise.reject(new Error("posthog unavailable"));
    });
    const afterTtl = resolvedAt + DISPLAYED_STATUS_PARITY_DECISION_TTL_MS + 1;

    expect(await resolveDisplayedStatusParity(identity, afterTtl)).toBe(false);
  });

  it("does not let one viewer's successful evaluation destroy another's outage fallback", async () => {
    // ISS-4556: the expired-entry sweep walked the WHOLE map, so viewer B's
    // successful evaluation deleted viewer A's expired entry — the exact fallback
    // the unavailable branch promises to hold. A's decision has to survive B.
    const isFeatureEnabled = vi.fn().mockResolvedValue(true);
    vi.mocked(analytics).isFeatureEnabled = isFeatureEnabled;
    const viewerA = { userId: "internal-a", clerkUserId: "user_clerk_a" };
    const viewerB = { userId: "internal-b", clerkUserId: "user_clerk_b" };
    const resolvedAt = Date.now();

    expect(await resolveDisplayedStatusParity(viewerA, resolvedAt)).toBe(true);

    // Past A's TTL, B evaluates successfully — the moment the sweep used to fire.
    const afterTtl = resolvedAt + DISPLAYED_STATUS_PARITY_DECISION_TTL_MS + 1;
    expect(await resolveDisplayedStatusParity(viewerB, afterTtl)).toBe(true);

    // Now A reads during an outage and must still get its own held decision.
    isFeatureEnabled.mockResolvedValue(undefined);
    expect(await resolveDisplayedStatusParity(viewerA, afterTtl)).toBe(true);
  });

  it("backs off instead of re-asking PostHog on every read during an outage", async () => {
    // ISS-4556: the unavailable branch returned WITHOUT re-arming `expiresAt`, so
    // a sustained outage re-issued a blocking PostHog call on each of the four
    // reads of every Sessions page load — no negative caching at all.
    const isFeatureEnabled = vi.fn().mockResolvedValue(undefined);
    vi.mocked(analytics).isFeatureEnabled = isFeatureEnabled;
    const identity = {
      userId: "internal-cold",
      clerkUserId: "user_clerk_cold",
    };
    const firstReadAt = Date.now();

    expect(await resolveDisplayedStatusParity(identity, firstReadAt)).toBe(
      false
    );
    const callsAfterFirstRead = isFeatureEnabled.mock.calls.length;
    expect(callsAfterFirstRead).toBeGreaterThan(0);

    // The remaining reads of the same page load are answered from the backoff
    // entry rather than each taking another swing at a failing service.
    expect(await resolveDisplayedStatusParity(identity, firstReadAt + 1)).toBe(
      false
    );
    expect(isFeatureEnabled).toHaveBeenCalledTimes(callsAfterFirstRead);

    // Past the backoff, recovery is picked up.
    isFeatureEnabled.mockResolvedValue(true);
    expect(
      await resolveDisplayedStatusParity(
        identity,
        firstReadAt + DISPLAYED_STATUS_PARITY_UNAVAILABLE_BACKOFF_MS + 1
      )
    ).toBe(true);
  });

  it("does not let two principals share a decision when their distinct ids join to the same string", async () => {
    // ISS-4556: the memo key was `distinctIds.join("|")`, which is not injective —
    // a principal whose id CONTAINS the separator collides with a different
    // principal's two-id key. Inheriting another viewer's decision means serving a
    // dark-launched feature to someone PostHog never enabled it for.
    const isFeatureEnabled = vi
      .fn()
      .mockImplementation((_flag: string, distinctId: string) =>
        Promise.resolve(distinctId === "a")
      );
    vi.mocked(analytics).isFeatureEnabled = isFeatureEnabled;
    const now = Date.now();

    // Ids ["a", "b"] — enabled, because "a" is enrolled.
    expect(
      await resolveDisplayedStatusParity({ clerkUserId: "a", userId: "b" }, now)
    ).toBe(true);

    // Ids ["a|b"] — a DIFFERENT principal, enrolled in nothing. Under the old key
    // both sides produced "a|b" and this read was answered from the memo above.
    expect(await resolveDisplayedStatusParity({ userId: "a|b" }, now)).toBe(
      false
    );
  });

  it("evicts the least-recently-refreshed viewer, not the first one ever seen", async () => {
    // ISS-4556: `Map.set` on an existing key keeps its ORIGINAL insertion slot, so
    // eviction from the front was first-SEEN order — which preferentially drops
    // the most ACTIVE viewers, the ones refreshing most often.
    const isFeatureEnabled = vi.fn().mockResolvedValue(true);
    vi.mocked(analytics).isFeatureEnabled = isFeatureEnabled;
    const now = Date.now();
    const busyViewer = { userId: "internal-busy" };

    // The busy viewer is seen FIRST, then the map is filled to exactly the cap —
    // no eviction yet, so the ordering question is still open when it refreshes.
    expect(await resolveDisplayedStatusParity(busyViewer, now)).toBe(true);
    for (let i = 0; i < DISPLAYED_STATUS_PARITY_DECISION_MAX_ENTRIES - 1; i++) {
      await resolveDisplayedStatusParity(
        { userId: `internal-filler-${i}` },
        now
      );
    }
    // The busy viewer refreshes, which must move it to the BACK of the queue.
    const afterTtl = now + DISPLAYED_STATUS_PARITY_DECISION_TTL_MS + 1;
    expect(await resolveDisplayedStatusParity(busyViewer, afterTtl)).toBe(true);

    // One more viewer pushes the map over the cap. The victim must be the oldest
    // UNREFRESHED filler, so the busy viewer is still memoized: it answers with no
    // further PostHog call. Without the delete-before-set the busy viewer is still
    // sitting in its original first slot and is the one evicted here.
    await resolveDisplayedStatusParity(
      { userId: "internal-newcomer" },
      afterTtl
    );
    const callsBefore = isFeatureEnabled.mock.calls.length;
    expect(await resolveDisplayedStatusParity(busyViewer, afterTtl)).toBe(true);
    expect(isFeatureEnabled).toHaveBeenCalledTimes(callsBefore);
  });

  it("bounds the decision map on the UNAVAILABLE path too", async () => {
    // ISS-4556: the entry cap is this map's ONLY bound, and the UNAVAILABLE
    // branch inserts an entry per viewer just as the success branch does — but
    // pruning used to run only after the success path, so the bound was
    // unenforced on exactly the path that runs when PostHog cannot answer.
    //
    // That is steady state, not merely an outage: with no `NEXT_PUBLIC_POSTHOG_KEY`
    // the analytics stub exposes no `isFeatureEnabled` at all, and posthog-node
    // resolves `undefined` for a flag key not yet created in the project — both
    // report UNAVAILABLE. So every viewer takes this branch for the whole window
    // before the flag exists, on an instance that is long-lived because `apps/api`
    // also serves Socket.IO.
    const now = Date.now();
    const strandedViewer = { userId: "internal-stranded" };

    // Seed ONE real decision first. That is what makes eviction observable: a
    // surviving entry keeps answering `true` (the branch's promise to "hold the
    // last known decision", which it does even once expired), so only an EVICTED
    // entry can fall back to the cold-start `false`.
    vi.mocked(analytics).isFeatureEnabled = vi.fn().mockResolvedValue(true);
    expect(await resolveDisplayedStatusParity(strandedViewer, now)).toBe(true);

    // ...then PostHog stops answering, and distinct viewers keep arriving. The
    // deleted property is the real "no analytics client configured" shape the
    // production guard tests, not a stand-in for it.
    Reflect.deleteProperty(analytics, "isFeatureEnabled");
    for (let i = 0; i <= DISPLAYED_STATUS_PARITY_DECISION_MAX_ENTRIES; i++) {
      await resolveDisplayedStatusParity(
        { userId: `internal-outage-${i}` },
        now
      );
    }

    // The oldest entry — the seeded one — must have been evicted by the cap.
    // Unpruned, the map simply grows and this viewer still answers `true`.
    expect(await resolveDisplayedStatusParity(strandedViewer, now)).toBe(false);
  });
});
