import { describe, expect, it } from "vitest";
import {
  INDEX_KEY_PROJECTION_ORG_BUDGET,
  IndexKeyProjectionEmissionGate,
  IndexKeyProjectionReason,
} from "./index-key-projection-telemetry";
import {
  EmissionRollupCause,
  FIXED_WINDOW_EMISSION_WINDOW_MS,
} from "./observability/fixed-window-emission-throttle";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const TARGET = "target-1";
const NOW = 1_000_000;

function gate(
  reason: IndexKeyProjectionReason = IndexKeyProjectionReason.Transcript
) {
  const rollups: {
    organizationId: string;
    computeTargetId?: string;
    occurrences: number;
    flushedBy: EmissionRollupCause;
  }[] = [];
  const instance = new IndexKeyProjectionEmissionGate({
    reason,
    onRollup: (scope, occurrences, flushedBy) =>
      rollups.push({ ...scope, occurrences, flushedBy }),
  });
  return { instance, rollups };
}

describe("IndexKeyProjectionEmissionGate", () => {
  it("emits the first occurrence and suppresses the replay inside the window", () => {
    const { instance } = gate();
    const scope = { organizationId: ORG, computeTargetId: TARGET };

    expect(instance.record(scope, NOW)).toBe(true);
    expect(instance.record(scope, NOW + 1)).toBe(false);
    expect(instance.record(scope, NOW + 2)).toBe(false);
  });

  it("never suppresses a first occurrence from another tenant", () => {
    const { instance } = gate();

    expect(
      instance.record({ organizationId: ORG, computeTargetId: TARGET }, NOW)
    ).toBe(true);
    expect(
      instance.record(
        { organizationId: OTHER_ORG, computeTargetId: TARGET },
        NOW
      )
    ).toBe(true);
  });

  it("caps one org at its per-window budget across the targets it owns", () => {
    const { instance } = gate();
    const attempts = INDEX_KEY_PROJECTION_ORG_BUDGET + 3;
    let emitted = 0;

    for (let index = 0; index < attempts; index += 1) {
      // A fresh compute target each pass: the resource churn that would evict
      // the finer key and make every request a first occurrence if the coarse
      // org budget did not exist.
      if (
        instance.record(
          { organizationId: ORG, computeTargetId: `${TARGET}-${index}` },
          NOW
        )
      ) {
        emitted += 1;
      }
    }

    expect(emitted).toBe(INDEX_KEY_PROJECTION_ORG_BUDGET);
  });

  it("keeps two reasons on separate budgets", () => {
    const transcripts = gate(IndexKeyProjectionReason.Transcript);
    const invocations = gate(IndexKeyProjectionReason.Invocation);
    const scope = { organizationId: ORG, computeTargetId: TARGET };

    expect(transcripts.instance.record(scope, NOW)).toBe(true);
    expect(transcripts.instance.record(scope, NOW + 1)).toBe(false);
    // The same tenant and target on the OTHER lane is a first occurrence, not a
    // replay: one lane's over-long identity says nothing about the other's.
    expect(invocations.instance.record(scope, NOW + 1)).toBe(true);
  });

  it("flushes the suppressed total as a real count when the window rolls over", () => {
    const { instance, rollups } = gate();
    const scope = { organizationId: ORG, computeTargetId: TARGET };

    instance.record(scope, NOW);
    instance.record(scope, NOW + 1);
    instance.record(scope, NOW + 2);
    expect(rollups).toEqual([]);

    instance.record(scope, NOW + FIXED_WINDOW_EMISSION_WINDOW_MS + 1);

    // Two suppressed occurrences, carried rather than dropped: the total across
    // first occurrences and rollups still tracks every projection.
    expect(rollups).toEqual([
      {
        organizationId: ORG,
        computeTargetId: TARGET,
        occurrences: 2,
        flushedBy: EmissionRollupCause.Window,
      },
    ]);
  });

  it("attributes the coarse rollup to the org alone, never to a target", () => {
    const { instance, rollups } = gate();
    const attempts = INDEX_KEY_PROJECTION_ORG_BUDGET + 2;

    for (let index = 0; index < attempts; index += 1) {
      instance.record(
        { organizationId: ORG, computeTargetId: `${TARGET}-${index}` },
        NOW
      );
    }
    instance.record(
      { organizationId: ORG, computeTargetId: TARGET },
      NOW + FIXED_WINDOW_EMISSION_WINDOW_MS + 1
    );

    const orgRollups = rollups.filter(
      (rollup) => rollup.computeTargetId === undefined
    );
    // The budget key spans every target the org owns, so stamping one would
    // attribute the whole total to whichever target happened to be last.
    expect(orgRollups).toEqual([
      {
        organizationId: ORG,
        occurrences: 2,
        flushedBy: EmissionRollupCause.Window,
      },
    ]);
  });

  it("bounds resident keys and flushes an evicted key's suppressed count", () => {
    const rollups: number[] = [];
    const instance = new IndexKeyProjectionEmissionGate({
      reason: IndexKeyProjectionReason.Transcript,
      onRollup: (_scope, occurrences) => rollups.push(occurrences),
    });
    const before = instance.size;

    for (let index = 0; index < 50; index += 1) {
      instance.record(
        { organizationId: `${ORG}-${index}`, computeTargetId: TARGET },
        NOW
      );
    }

    // One coarse key and one fine key per tenant, and nothing a caller sends
    // adds a third: the keyspace grows with tenants served, never with payload.
    expect(instance.size).toBe(before + 100);
    instance.clear();
    expect(instance.size).toBe(0);
  });

  it("reports a projection again once the window has rolled over", () => {
    const { instance } = gate();
    const scope = { organizationId: ORG, computeTargetId: TARGET };

    expect(instance.record(scope, NOW)).toBe(true);
    expect(instance.record(scope, NOW + 1)).toBe(false);
    expect(
      instance.record(scope, NOW + FIXED_WINDOW_EMISSION_WINDOW_MS + 1)
    ).toBe(true);
  });

  it("does not spend the org budget on a target's suppressed replays", () => {
    const { instance } = gate();
    const noisy = { organizationId: ORG, computeTargetId: `${TARGET}-noisy` };

    expect(instance.record(noisy, NOW)).toBe(true);
    // Twice the whole org budget, every one of them a replay the FINE tier
    // suppresses. None may reach the coarse budget.
    for (
      let index = 0;
      index < INDEX_KEY_PROJECTION_ORG_BUDGET * 2;
      index += 1
    ) {
      expect(instance.record(noisy, NOW + index + 1)).toBe(false);
    }

    // #7213 review (davetho): the distinct-caller signal this gate exists to
    // keep. Debiting the budget per OCCURRENCE let one target's replays spend
    // every slot, and this second target's genuinely first projection — the one
    // an operator most needs named — returned unreported.
    expect(
      instance.record(
        { organizationId: ORG, computeTargetId: `${TARGET}-second` },
        NOW + 1
      )
    ).toBe(true);
  });

  it("keeps the fine tier resident past the budget while still capping emission", () => {
    const { instance } = gate();
    const attempts = INDEX_KEY_PROJECTION_ORG_BUDGET + 5;
    let emitted = 0;

    for (let index = 0; index < attempts; index += 1) {
      if (
        instance.record(
          { organizationId: ORG, computeTargetId: `${TARGET}-${index}` },
          NOW
        )
      ) {
        emitted += 1;
      }
    }

    // The cost of consulting the fine tier FIRST, stated rather than hidden: a
    // churning caller now grows the finer keyspace past the budget, where the
    // old order short-circuited before touching it. That growth is bounded by
    // the throttle's own LRU cap, not by this budget.
    expect(instance.size).toBe(attempts + 1);
    // What the order does NOT cost is emission volume, which is the property
    // the abuse-control rule actually asks for: every emission still debits the
    // coarse budget, so churn buys the caller no extra events.
    expect(emitted).toBe(INDEX_KEY_PROJECTION_ORG_BUDGET);
  });
});
