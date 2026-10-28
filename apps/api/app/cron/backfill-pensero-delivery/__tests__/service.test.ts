/**
 * ISS-8761: the degraded and failure branches of the scheduled sweep.
 *
 * The route suite proves the happy path end to end through the real backfill.
 * This one drives the branches a real provider cannot be asked for on demand —
 * a truncated plan, a signalled truncation, a run whose budget ran out — by
 * injecting the backfill entry point. Everything else (the planner, the ledger,
 * the cursors, the credential resolver, the metric emitters) is production code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockEmitTelemetryMetric, mockFetchDeliverySegment } = vi.hoisted(
  () => ({
    mockEmitTelemetryMetric: vi.fn(),
    mockFetchDeliverySegment: vi.fn(),
  })
);

// Only the TRANSPORT is faked; `SegmentCompleteness` and everything else stay
// real, so a stub cannot drift from the client's own contract.
vi.mock("@repo/pensero/delivery-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@repo/pensero/delivery-client")>();
  return { ...actual, fetchDeliverySegment: mockFetchDeliverySegment };
});

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  const mocked = Object.assign(vi.fn(), { tx: vi.fn() });
  return { ...actual, withDb: mocked };
});

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mockEmitTelemetryMetric,
}));

vi.mock("@repo/pensero/keys", () => ({
  keys: () => ({
    PENSERO_API_TOKEN: undefined,
    PENSERO_API_BASE_URL: undefined,
  }),
}));

vi.mock("@/lib/crypto/kms-secret", () => ({
  KmsSecretPurpose: { PenseroApiToken: "pensero-api-token" },
  decryptSecret: (ciphertext: string) =>
    Promise.resolve(ciphertext.replace("enc:", "")),
}));

import { NumeratorProvider } from "@repo/api/src/types/numerator-provider";
import { DeliveryMatchOutcome, withDb } from "@repo/database";
import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import { SegmentCompleteness } from "@repo/pensero/delivery-client";
import { PullRequestResolution } from "@repo/pensero/delivery-interaction-join";
import type { DeliveryBackfillReport } from "@/lib/delivery-points/pensero-delivery-backfill";
import { PenseroBackfillDegradedReason } from "@/lib/observability/pensero-backfill-metrics";
import {
  formatValidationSummary,
  sweepPenseroDeliveryBackfill,
  validatePenseroDeliveryBackfill,
} from "../service";

const ORG = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-04T09:00:00.000Z");
const TODAY_DAY = "2026-08-04";

type LedgerRow = {
  organizationId: string;
  day: string;
  lastSuccessAt: Date | null;
  lastFailureReason: string | null;
  attemptCount: number;
  lastRowsWritten: number;
};

let ledger: LedgerRow[] = [];
let cursors: {
  organizationId: string;
  backwardCursor: Date | null;
  recheckCursor: Date | null;
}[] = [];
/** When each org's cursor row was last written — the sweep-ordering input. */
let sweptAt = new Map<string, Date>();
/** Organizations the fake `penseroIntegration.findMany` reports, in id order. */
let configuredOrganizations: {
  organizationId: string;
  teamIdentifiers: string[];
}[] = [];

function isoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function makeFakeDb() {
  return {
    penseroIntegration: {
      findMany: () => Promise.resolve(configuredOrganizations),
      findUnique: () =>
        Promise.resolve({
          apiTokenEncrypted: "enc:tk_a:sk_b",
          baseUrl: null,
        }),
    },
    penseroBackfillDay: {
      findMany: () =>
        Promise.resolve(
          ledger
            .slice()
            .sort((a, b) => a.day.localeCompare(b.day))
            .map((row) => ({ day: new Date(`${row.day}T00:00:00.000Z`) }))
        ),
      upsert: (args: {
        where: { organizationId_day: { organizationId: string; day: Date } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const key = isoDay(args.where.organizationId_day.day);
        const existing = ledger.find((row) => row.day === key);
        if (existing) {
          const update = args.update;
          existing.attemptCount += 1;
          if ("lastSuccessAt" in update) {
            existing.lastSuccessAt = update.lastSuccessAt as Date;
            existing.lastRowsWritten = update.lastRowsWritten as number;
          }
          existing.lastFailureReason =
            (update.lastFailureReason as string | null) ?? null;
          return Promise.resolve(existing);
        }
        const create = args.create;
        const row: LedgerRow = {
          organizationId: ORG,
          day: key,
          lastSuccessAt: (create.lastSuccessAt as Date | null) ?? null,
          lastFailureReason:
            (create.lastFailureReason as string | null) ?? null,
          attemptCount: create.attemptCount as number,
          lastRowsWritten: create.lastRowsWritten as number,
        };
        ledger.push(row);
        return Promise.resolve(row);
      },
    },
    penseroBackfillCursor: {
      // Feeds the least-recently-swept ordering (#6492). `updatedAt` is what
      // `@updatedAt` writes on every cursor write, which is once per org per
      // sweep, so it already IS the last-swept time.
      findMany: () =>
        Promise.resolve(
          cursors.map((row) => ({
            organizationId: row.organizationId,
            updatedAt: sweptAt.get(row.organizationId) ?? new Date(0),
          }))
        ),
      findUnique: () => Promise.resolve(cursors.at(0) ?? null),
      upsert: (args: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const existing = cursors.at(0);
        if (existing) {
          // Only the fields the UPDATE actually names. Applying `create` here
          // would let the fake move `backwardCursor` on a path production
          // deliberately does not, and hide the guard below.
          const next = args.update as { recheckCursor?: Date | null };
          if ("recheckCursor" in next) {
            existing.recheckCursor = next.recheckCursor ?? null;
          }
          return Promise.resolve(existing);
        }
        cursors.push(
          args.create as unknown as {
            organizationId: string;
            backwardCursor: Date | null;
            recheckCursor: Date | null;
          }
        );
        return Promise.resolve(cursors[0]);
      },
      // Models the MONOTONIC guard, including its predicate. A fake that
      // updated unconditionally would make every cursor assertion below pass
      // for the wrong reason.
      updateMany: (args: {
        where: {
          OR: [{ backwardCursor: null }, { backwardCursor: { gt: Date } }];
        };
        data: { backwardCursor: Date };
      }) => {
        const existing = cursors.at(0);
        const threshold = args.where.OR[1].backwardCursor.gt;
        if (
          existing &&
          (existing.backwardCursor === null ||
            existing.backwardCursor > threshold)
        ) {
          existing.backwardCursor = args.data.backwardCursor;
          return Promise.resolve({ count: 1 });
        }
        return Promise.resolve({ count: 0 });
      },
    },
  };
}

/**
 * A report whose numbers are stated here rather than derived from the module
 * under test, so an assertion below cannot be satisfied by the same arithmetic
 * it is policing.
 */
function makeReport(
  overrides: Partial<DeliveryBackfillReport> = {}
): DeliveryBackfillReport {
  return {
    organizationId: ORG,
    providerId: NumeratorProvider.Pensero,
    segmentsPlanned: 1,
    segmentsFetched: 1,
    segmentsFailed: [],
    planTruncated: false,
    rowsExtracted: 0,
    rowsRejected: 0,
    peopleRejected: 0,
    interactionsSeededFromStore: 0,
    peopleUnbridged: 0,
    resolutionCounts: {
      [PullRequestResolution.Direct]: 0,
      [PullRequestResolution.Interaction]: 0,
      [PullRequestResolution.NoInteraction]: 0,
      [PullRequestResolution.NoCounterpart]: 0,
      [PullRequestResolution.Ambiguous]: 0,
    },
    outcomeCounts: {
      [DeliveryMatchOutcome.MATCHED]: 0,
      [DeliveryMatchOutcome.NO_COUNTERPART]: 0,
      [DeliveryMatchOutcome.AMBIGUOUS]: 0,
      [DeliveryMatchOutcome.UNMATCHABLE]: 0,
      [DeliveryMatchOutcome.PENDING_REFERENCE]: 0,
    },
    rowsWritten: 0,
    artifactAssociationsWritten: 0,
    completeness: SegmentCompleteness.Unverified,
    ...overrides,
  };
}

function emittedDegradedReasons(): string[] {
  return mockEmitTelemetryMetric.mock.calls
    .map((call) => call[0])
    .filter((payload) => payload.metric === FilterToken.PenseroBackfillDegraded)
    .map((payload) => payload.reason);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  ledger = [];
  cursors = [];
  sweptAt = new Map();
  configuredOrganizations = [{ organizationId: ORG, teamIdentifiers: [] }];
  vi.clearAllMocks();
  const db = makeFakeDb();
  vi.mocked(withDb).mockImplementation((callback) =>
    Promise.resolve(callback(db as never))
  );
  vi.mocked(withDb.tx).mockImplementation((callback) =>
    Promise.resolve(callback(db as never))
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sweepPenseroDeliveryBackfill", () => {
  it("AC3: planTruncated is monitored, fails the day, and holds the cursor", async () => {
    const summary = await sweepPenseroDeliveryBackfill({
      now: NOW,
      maxDaysPerOrganization: 2,
      backwardDaysPerRun: 1,
      runBackfill: (options) =>
        Promise.resolve(
          makeReport({
            planTruncated: options.endDate.toISOString().startsWith(TODAY_DAY),
          })
        ),
    });

    expect(emittedDegradedReasons()).toContain(
      PenseroBackfillDegradedReason.PlanTruncated
    );
    // A truncated plan is NOT a quiet day: the day is recorded as failed so the
    // backward walk comes back to it, rather than banking a hole as done.
    const today = ledger.find((row) => row.day === TODAY_DAY);
    expect(today?.lastSuccessAt).toBeNull();
    expect(today?.lastFailureReason).toBe(
      PenseroBackfillDegradedReason.PlanTruncated
    );
    expect(summary.daysFailed).toBe(1);
    expect(summary.degraded).toBe(true);
  });

  it("AC3: a signalled truncation is monitored but still a successful attempt", async () => {
    await sweepPenseroDeliveryBackfill({
      now: NOW,
      maxDaysPerOrganization: 1,
      backwardDaysPerRun: 1,
      runBackfill: () =>
        Promise.resolve(
          makeReport({
            completeness: SegmentCompleteness.TruncationSignalled,
          })
        ),
    });

    expect(emittedDegradedReasons()).toContain(
      PenseroBackfillDegradedReason.TruncationSignalled
    );
    // The fetch DID return, so it is an attempt that happened; what it cannot
    // claim is that the window was whole, and nothing here claims it.
    expect(ledger.find((row) => row.day === TODAY_DAY)?.lastSuccessAt).toEqual(
      NOW
    );
  });

  it("AC3: an exhausted budget reports continuation rather than discarding days", async () => {
    const summary = await sweepPenseroDeliveryBackfill({
      now: NOW,
      maxDaysPerOrganization: 2,
      backwardDaysPerRun: 5,
      runBackfill: () => Promise.resolve(makeReport()),
    });

    expect(summary.continuationPending).toBe(true);
    expect(emittedDegradedReasons()).toContain(
      PenseroBackfillDegradedReason.ContinuationPending
    );
    // The cursor persists exactly where the budget stopped, so the next run
    // resumes below it instead of re-walking or skipping.
    expect(cursors.at(0)?.backwardCursor).toEqual(
      new Date("2026-08-03T00:00:00.000Z")
    );
  });

  it("resumes from the persisted cursor across two consecutive runs", async () => {
    const asked: string[] = [];
    const runBackfill = (options: { endDate: Date }) => {
      asked.push(isoDay(options.endDate));
      return Promise.resolve(makeReport());
    };

    await sweepPenseroDeliveryBackfill({
      now: NOW,
      maxDaysPerOrganization: 3,
      backwardDaysPerRun: 2,
      runBackfill,
    });
    const firstRun = [...asked];
    asked.length = 0;

    await sweepPenseroDeliveryBackfill({
      now: NOW,
      maxDaysPerOrganization: 3,
      backwardDaysPerRun: 2,
      runBackfill,
    });

    expect(firstRun).toEqual(["2026-08-04", "2026-08-03", "2026-08-02"]);
    // The second run does not restart at 08-03 and does not skip 08-01: the
    // backward lane picks up strictly below the cursor, and the freed budget
    // goes to the recheck lane rather than being lost.
    expect(asked.slice(0, 3)).toEqual([
      "2026-08-04",
      "2026-08-01",
      "2026-07-31",
    ]);
  });

  it("keeps a thrown organization from stopping the sweep", async () => {
    const summary = await sweepPenseroDeliveryBackfill({
      now: NOW,
      maxDaysPerOrganization: 1,
      backwardDaysPerRun: 1,
      runBackfill: () => Promise.reject(new Error("provider exploded")),
    });

    expect(summary.daysFailed).toBe(1);
    expect(summary.degraded).toBe(true);
    expect(ledger.find((row) => row.day === TODAY_DAY)?.lastFailureReason).toBe(
      "provider exploded"
    );
    expect(
      mockEmitTelemetryMetric.mock.calls
        .map((call) => call[0])
        .some(
          (payload) => payload.metric === FilterToken.PenseroBackfillDayFailed
        )
    ).toBe(true);
  });

  it("keeps a failure from overwriting the last time the day actually worked", async () => {
    await sweepPenseroDeliveryBackfill({
      now: NOW,
      maxDaysPerOrganization: 1,
      backwardDaysPerRun: 1,
      runBackfill: () => Promise.resolve(makeReport({ rowsWritten: 7 })),
    });

    const later = new Date("2026-08-04T18:00:00.000Z");
    await sweepPenseroDeliveryBackfill({
      now: later,
      maxDaysPerOrganization: 1,
      backwardDaysPerRun: 1,
      runBackfill: () => Promise.reject(new Error("502")),
    });

    const today = ledger.find((row) => row.day === TODAY_DAY);
    // "Failing since 18:00" and "never worked" are different facts, and the
    // second write must not erase the first.
    expect(today?.lastSuccessAt).toEqual(NOW);
    expect(today?.lastRowsWritten).toBe(7);
    expect(today?.lastFailureReason).toBe("502");
    expect(today?.attemptCount).toBe(2);
  });

  it("stops at the wall-clock deadline and still writes the cursors it earned", async () => {
    // codex + whitlockk (#6492). One slow tenant used to run every planned day to
    // its 30 s timeout — 420 s against a 300 s route ceiling — so Vercel killed
    // the invocation before ANY cursor was written. The org lost its own
    // progress AND starved everyone after it, every run.
    //
    // The clock is a COUNTER, not the wall clock: each read advances it, so the
    // deadline is crossed deterministically rather than by waiting. A real
    // sleep here would be the timing-based assertion the repo bans.
    let elapsed = 0;
    const askedFor: string[] = [];

    const summary = await sweepPenseroDeliveryBackfill({
      now: NOW,
      maxDaysPerOrganization: 6,
      backwardDaysPerRun: 5,
      budgetMs: 5,
      elapsedNowMs: () => {
        const value = elapsed;
        elapsed += 1;
        return value;
      },
      runBackfill: (options) => {
        askedFor.push(options.endDate.toISOString().slice(0, 10));
        return Promise.resolve(makeReport({ rowsWritten: 1 }));
      },
    });

    // It stopped SHORT of the plan — the whole point — but it did ask for
    // something, so this is a bound rather than a sweep that never started.
    expect(askedFor.length).toBeGreaterThan(0);
    expect(askedFor.length).toBeLessThan(6);
    expect(summary.daysAttempted).toBe(askedFor.length);
    expect(summary.continuationPending).toBe(true);

    // THE TEETH: the cursor write happened anyway. This is the half a killed
    // invocation loses, and losing it is what makes the next run redo the same
    // days forever.
    expect(cursors.at(0)?.backwardCursor).not.toBeNull();
    expect(emittedDegradedReasons()).toContain(
      PenseroBackfillDegradedReason.ContinuationPending
    );
  });

  it("defers the organizations the budget could not reach, and names them", async () => {
    const otherOrg = "22222222-2222-4222-8222-222222222222";
    configuredOrganizations = [
      { organizationId: ORG, teamIdentifiers: [] },
      { organizationId: otherOrg, teamIdentifiers: [] },
    ];
    // Already past the deadline on the very first read, so no organization is
    // swept and both are deferred rather than silently dropped.
    // The FIRST read establishes the deadline; every read after it is already
    // past it, so no organization is reached.
    let reads = 0;
    const summary = await sweepPenseroDeliveryBackfill({
      now: NOW,
      budgetMs: 1,
      elapsedNowMs: () => (reads++ === 0 ? 0 : 1_000_000),
      runBackfill: () => Promise.resolve(makeReport()),
    });

    expect(summary.organizationsConsidered).toBe(2);
    expect(summary.organizationsSwept).toBe(0);
    expect(summary.organizationsDeferred).toBe(2);
    expect(summary.continuationPending).toBe(true);
    // Deferral under a fair rotation is the budget working, not an incident —
    // it must stay off the channel that pages someone.
    expect(summary.degraded).toBe(false);
    expect(emittedDegradedReasons()).toContain(
      PenseroBackfillDegradedReason.SweepBudgetExhausted
    );
  });

  it("sweeps the LEAST-RECENTLY-SWEPT organization first", async () => {
    // The other half of the budget fix (codex + whitlockk, #6492), and the half the
    // budget makes load-bearing. A bounded sweep under the previous fixed
    // `organizationId ASC` ordering is not a deferral, it is permanent
    // starvation: the same alphabetical prefix spends the budget every night and
    // the tail is NEVER reached. `staleOrg` sorts LAST by id and was swept
    // longest ago, so id-order and swept-order disagree here — which is what
    // makes this case able to fail.
    const staleOrg = "99999999-9999-4999-8999-999999999999";
    configuredOrganizations = [
      { organizationId: ORG, teamIdentifiers: [] },
      { organizationId: staleOrg, teamIdentifiers: [] },
    ];
    cursors = [
      { organizationId: ORG, backwardCursor: null, recheckCursor: null },
      { organizationId: staleOrg, backwardCursor: null, recheckCursor: null },
    ];
    sweptAt = new Map([
      [ORG, new Date("2026-08-04T08:00:00.000Z")],
      [staleOrg, new Date("2026-07-01T08:00:00.000Z")],
    ]);

    const sweptOrder: string[] = [];
    await sweepPenseroDeliveryBackfill({
      now: NOW,
      maxDaysPerOrganization: 1,
      backwardDaysPerRun: 0,
      runBackfill: (options) => {
        if (sweptOrder.at(-1) !== options.organizationId) {
          sweptOrder.push(options.organizationId);
        }
        return Promise.resolve(makeReport());
      },
    });

    expect(sweptOrder).toEqual([staleOrg, ORG]);
  });

  it("does not advance the backward cursor over a failed backward day", async () => {
    // The end-to-end half of the `advanceBackwardCursor` unit cases: the
    // service must hand that function the BACKWARD lane in walk order, not the
    // undifferentiated success list it used to build. Aug 3 (the first backward
    // day) fails while Aug 2 succeeds; a cursor at Aug 2 would mean Aug 3 is
    // never walked again.
    const failedDay = "2026-08-03";
    await sweepPenseroDeliveryBackfill({
      now: NOW,
      maxDaysPerOrganization: 3,
      backwardDaysPerRun: 2,
      runBackfill: (options) =>
        options.endDate.toISOString().startsWith(failedDay)
          ? Promise.reject(new Error("502"))
          : Promise.resolve(makeReport()),
    });

    // Null, because nothing contiguous succeeded below the (absent) cursor —
    // and emphatically NOT Aug 2, which is what taking the minimum produced.
    expect(cursors.at(0)?.backwardCursor).toBeNull();
  });
});

/** Organizations in swept-order, since none of them has a cursor row. */
function configureOrganizations(count: number): string[] {
  const ids = Array.from(
    { length: count },
    (_, index) => `${index + 1}1111111-1111-4111-8111-111111111111`
  );
  configuredOrganizations = ids.map((organizationId) => ({
    organizationId,
    teamIdentifiers: [],
  }));
  return ids;
}

describe("validatePenseroDeliveryBackfill", () => {
  it("stops at the wall-clock deadline and returns the partial result", async () => {
    // tamsinb + whitlockk (#6747). Validation walks organizations SERIALLY and
    // every `fetchDeliverySegment` carries a 30 s timeout, so eleven unreachable
    // tenants is 330 s against the route's `maxDuration = 300`. Vercel killed
    // the invocation and the operator got NOTHING — in exactly the scenario the
    // probe exists to diagnose. It now shares the sweep's deadline.
    //
    // The clock is a COUNTER, not the wall clock: the first read establishes
    // the deadline, the read before the second organization is already past it.
    // A real stall here would be the timing-based assertion this repo bans.
    configureOrganizations(3);
    mockFetchDeliverySegment.mockResolvedValue({
      segment: { rows: [{}, {}] },
      completeness: SegmentCompleteness.Unverified,
      continuationKeysSeen: [],
    });
    let reads = 0;

    const summary = await validatePenseroDeliveryBackfill({
      now: NOW,
      budgetMs: 10,
      elapsedNowMs: () => (reads++ < 2 ? 0 : 1_000_000),
    });

    // It came back AT ALL, having asked exactly once — a bound, not a probe
    // that never started and not one that ran the whole list.
    expect(mockFetchDeliverySegment).toHaveBeenCalledTimes(1);
    expect(summary.organizationsValidated).toBe(1);
    expect(summary.rowsSeen).toBe(2);

    // THE TEETH: the two it never reached are counted as UNKNOWN, not as
    // healthy. An operator reading `orgs=3 validated=3` on a run that fetched
    // once would take a killed probe for a clean bill of health.
    expect(summary.organizationsDeferred).toBe(2);
    expect(
      summary.organizationsValidated +
        summary.organizationsSkipped +
        summary.organizationsFailed +
        summary.organizationsDeferred
    ).toBe(summary.organizationsConsidered);

    // And the distinction survives into the one line the operator actually
    // reads, rather than living only on the object.
    const formatted = formatValidationSummary(summary);
    expect(formatted).toContain("validated=1");
    expect(formatted).toContain("orgsDeferred=2");
  });

  it("checks every organization when the budget is not exhausted", async () => {
    // The positive control for the case above: the deadline must bound a slow
    // run, not silently truncate a healthy one.
    configureOrganizations(3);
    mockFetchDeliverySegment.mockResolvedValue({
      segment: { rows: [] },
      completeness: SegmentCompleteness.Unverified,
      continuationKeysSeen: [],
    });

    const summary = await validatePenseroDeliveryBackfill({ now: NOW });

    expect(mockFetchDeliverySegment).toHaveBeenCalledTimes(3);
    expect(summary.organizationsValidated).toBe(3);
    expect(summary.organizationsDeferred).toBe(0);
    expect(summary.degraded).toBe(false);
  });

  it("labels the dominant failure by ORGANIZATION, not by day", async () => {
    // whitlockk (#6747). This probe samples exactly ONE day per tenant, so its
    // failure count is a number of TENANTS. Rendered under the sweep's
    // `dominantFailureDays`, seven bad credentials reported seven failed days
    // from a single day's sample — a count over a population the run never had.
    const reason =
      "Pensero delivery request failed: 401 (endpoint=/v1/delivery basePathSegments=0)";
    configureOrganizations(7);
    mockFetchDeliverySegment.mockRejectedValue(new Error(reason));

    const summary = await validatePenseroDeliveryBackfill({ now: NOW });
    const formatted = formatValidationSummary(summary);

    expect(summary.organizationsFailed).toBe(7);
    expect(summary.organizationFailureSummary?.count).toBe(7);
    expect(formatted).toContain("dominantFailureOrgs=7");
    expect(formatted).not.toContain("dominantFailureDays");
  });
});
