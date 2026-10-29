import {
  METERED_BILLING_MODES,
  SUBSCRIPTION_BILLING_MODES,
} from "@repo/api/src/types/billing-mode";
import type { Prisma } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCostGroupRow, SessionCostSplit } from "./usage-cost-split";

// Drive the classifier through a fake `withDb` that returns whatever the test
// stages for the cost `groupBy`. `withDb((db) => db...)` just invokes the
// callback with the staged fake client.
let costGroupRows: SessionCostGroupRow[] = [];

vi.mock("@repo/database", async () => {
  // Spread the shared module mock so the contract enums this suite's import
  // graph reaches at runtime (records.ts reads `ArtifactType`) are present —
  // ISS-5075 review: a partial mock is a mock gap to close, not a reason to
  // shape production imports around it. The bespoke `withDb` below still owns
  // the staged query.
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return {
    ...databaseModuleMock(),
    withDb: (fn: (db: unknown) => unknown) =>
      Promise.resolve(
        fn({
          sessionDetail: { groupBy: () => Promise.resolve(costGroupRows) },
        })
      ),
  };
});

const { computeSessionCostSplit, SessionCostLedger, splitSessionCost } =
  await import("./usage-cost-split");

const WHERE = {} as Prisma.SessionDetailWhereInput;
const SUBSCRIPTION_MODE = [...SUBSCRIPTION_BILLING_MODES][0];
const METERED_MODE = [...METERED_BILLING_MODES][0];

function row(
  legacyLoopCostLedger: string | null,
  billingMode: string | null,
  cost: number
): SessionCostGroupRow {
  return { legacyLoopCostLedger, billingMode, _sum: { estimatedCost: cost } };
}

beforeEach(() => {
  costGroupRows = [];
});

describe("usage-cost-split — API vs subscription classification (FEA-3986/FEA-4295)", () => {
  it("classifies a former loop session by its stored ledger, ignoring billingMode (ISS-12435)", () => {
    const split: SessionCostSplit = splitSessionCost([
      row(SessionCostLedger.Subscription, METERED_MODE, 10),
      row(SessionCostLedger.Metered, SUBSCRIPTION_MODE, 7),
    ]);

    expect(split.subscriptionEstimatedCost).toBe(10);
    expect(split.apiEstimatedCost).toBe(7);
  });

  it("classifies a DESKTOP_SYNC row (no source loop) by its billingMode", () => {
    const split = splitSessionCost([
      row(null, SUBSCRIPTION_MODE, 12),
      row(null, METERED_MODE, 3),
      row(null, null, 5), // legacy null ⇒ not-subscription
    ]);

    expect(split.subscriptionEstimatedCost).toBe(12);
    // 3 (metered) + 5 (legacy null) both fall to the not-subscription bucket.
    expect(split.apiEstimatedCost).toBe(8);
  });

  it("keeps subscription-covered spend out of apiEstimatedCost", () => {
    const split = splitSessionCost([
      row(SessionCostLedger.Subscription, null, 500), // subscription, must NOT reach API
      row(null, METERED_MODE, 42),
    ]);

    expect(split.apiEstimatedCost).toBe(42);
    expect(split.apiEstimatedCost).not.toBe(542);
  });

  it("computeSessionCostSplit runs the groupBy over the given where and returns the split", async () => {
    costGroupRows = [row(null, METERED_MODE, 25)];
    const split = await computeSessionCostSplit(WHERE);

    expect(split.apiEstimatedCost).toBe(25);
    expect(split.subscriptionEstimatedCost).toBe(0);
  });

  it("returns a zeroed split for an empty snapshot", () => {
    const split = splitSessionCost([]);

    expect(split).toEqual({
      // ISS-6526: the split now also owns the grand total, so the exhaustive
      // shape gained a key. Kept as `toEqual` rather than relaxed to
      // `objectContaining` — the point of this case is that an empty snapshot
      // produces zeros and nothing else.
      totalEstimatedCost: 0,
      subscriptionEstimatedCost: 0,
      apiEstimatedCost: 0,
      meteredEstimatedCost: 0,
      unknownEstimatedCost: 0,
    });
  });
});

describe("usage-cost-split — three-way metered/unknown split (ISS-4773)", () => {
  it("separates CONFIRMED metered spend from usage whose billing mode was never determined", () => {
    // The reported shape, in miniature: a subscription-heavy account whose
    // not-subscription bucket is dominated by rows the collector could not
    // classify. Before ISS-4773 the Cost card summed all $16,800 of this as
    // definite spend; only the $42 is money anyone was actually billed.
    const split = splitSessionCost([
      row(null, SUBSCRIPTION_MODE, 2030),
      row(null, METERED_MODE, 42),
      row(null, "unknown", 16_783),
      row(null, null, 5), // legacy null — also undetermined, not spend
    ]);

    expect(split.meteredEstimatedCost).toBe(42);
    expect(split.unknownEstimatedCost).toBe(16_788);
    expect(split.subscriptionEstimatedCost).toBe(2030);
    // Pinned as a hand-summed literal, not re-derived from the fields above.
    expect(split.totalEstimatedCost).toBe(18_860);
  });

  it("keeps apiEstimatedCost equal to metered + unknown so no existing consumer moves", () => {
    const split = splitSessionCost([
      row(null, METERED_MODE, 42),
      row(null, "unknown", 16_783),
      row(null, SUBSCRIPTION_MODE, 2030),
    ]);

    expect(split.apiEstimatedCost).toBe(
      split.meteredEstimatedCost + split.unknownEstimatedCost
    );
    expect(split.apiEstimatedCost).toBe(16_825);
  });

  it("treats an unrecognized future billingMode as unclassified, never as confirmed spend", () => {
    // Fail-safe direction: a mode this build has never heard of must not be
    // reported as money the reader spent. The old binary classifier had no way
    // to express this and folded it straight into the headline.
    const split = splitSessionCost([row(null, "some_future_mode", 99)]);

    expect(split.meteredEstimatedCost).toBe(0);
    expect(split.unknownEstimatedCost).toBe(99);
  });

  it("classifies a former loop session: metered ledger ⇒ metered, unknown or unrecognized ⇒ unclassified", () => {
    // An unknown ledger (the loop had no `apiKeySource`, or its row was gone) is
    // not subscription-covered, but it is not confirmed API spend either; a
    // stored value outside the three ledgers never counts as a confirmed bucket.
    const split = splitSessionCost([
      row(SessionCostLedger.Metered, null, 7),
      row(SessionCostLedger.Unknown, SUBSCRIPTION_MODE, 13),
      row("not-a-ledger", METERED_MODE, 4),
    ]);

    expect(split.meteredEstimatedCost).toBe(7);
    expect(split.unknownEstimatedCost).toBe(17);
    expect(split.subscriptionEstimatedCost).toBe(0);
  });
});
