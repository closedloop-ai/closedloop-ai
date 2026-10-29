/**
 * @file sync-lane-give-up-refusals.test.ts
 * @description ISS-9418: the `sync.lane.gave_up` reporter's OWN refusal
 * contract, driven directly rather than through a lane seam.
 *
 * Split out of `sync-lane-give-up-telemetry.test.ts`, which owns a different
 * claim and had reached the file-size ceiling: that suite pins what the
 * production tick path CALLS, once per transition; this one pins what the
 * boundary does with a value that is not a measurement, whoever hands it over.
 *
 * The lane suite pins the producer that hands it one: a relaunch inside an
 * outage opens a fresh run, so the failure that notices the resumed give-up
 * measures `0` against an outage over a day old. That producer passes `null`
 * instead, and these cases are what keeps the boundary refusing a value that
 * arrives as a NUMBER - a NaN from an arithmetic hole, a negative from a
 * backwards clock step, or a magnitude that no exact count could be, none of
 * which any caller-side check catches.
 */

import {
  LaneGiveUpSource,
  SyncLane,
  SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSyncLaneGiveUpAnnouncement,
  reportSyncLaneGaveUp,
} from "../src/main/telemetry/sync-lane-give-up-telemetry.js";
import {
  type GiveUpTelemetryCapture,
  installGiveUpTelemetryCapture,
  resetGiveUpTelemetryCapture,
} from "./sync-lane-give-up-telemetry-fixtures.js";

const GAVE_UP = "sync.lane.gave_up";

let capture: GiveUpTelemetryCapture;

beforeEach(() => {
  // The announcement latch is module-level and bounded by the closed lane set,
  // so it outlives a single case. Reset it BY NAME: a case that passed only
  // because a sibling had already announced the same lane is a false green.
  clearSyncLaneGiveUpAnnouncement(SyncLane.ComponentInventory);
  capture = installGiveUpTelemetryCapture();
});

afterEach(() => {
  resetGiveUpTelemetryCapture();
  vi.restoreAllMocks();
});

describe("give-up diagnostics refuse a value that is not a measurement", () => {
  function gaveUpWithStalledFor(stalledForMs: number) {
    reportSyncLaneGaveUp({
      lane: SyncLane.ComponentInventory,
      reason: SyncReason.TransportError,
      source: LaneGiveUpSource.EnvironmentalGate,
      stalledForMs,
      itemsOwed: null,
      deadLetteredCount: null,
    });
    return capture.categoriesOf(GAVE_UP)[0];
  }

  it("OMITS a NaN duration rather than reporting an instant give-up", () => {
    const gaveUp = gaveUpWithStalledFor(Number.NaN);

    // A `0` here renders as "gave up instantly" on the one field that says how
    // long the outage has been running - the plausible-but-wrong number, on the
    // only channel a give-up is ever observed.
    expect(gaveUp?.diagnostics?.syncLaneGaveUp).toEqual({
      lane: SyncLane.ComponentInventory,
      reason: SyncReason.TransportError,
      source: LaneGiveUpSource.EnvironmentalGate,
    });
    expect(
      Object.hasOwn(gaveUp?.diagnostics?.syncLaneGaveUp ?? {}, "stalledForMs")
    ).toBe(false);
    // And the prose, which is the half an operator actually reads, must not
    // launder it back into a number.
    expect(gaveUp?.message).toContain("an UNMEASURED interval");
    expect(gaveUp?.message).not.toContain("after 0min");
  });

  it("OMITS a negative duration rather than clamping it to zero", () => {
    // A backwards clock step. Clamping satisfies the validator with a `0`, and a
    // `0` is a measurement, so the clamp would launder a broken clock into a
    // reading the receiving schema then has no way to reject.
    const gaveUp = gaveUpWithStalledFor(-1);

    expect(gaveUp?.diagnostics?.syncLaneGaveUp?.stalledForMs).toBeUndefined();
    expect(gaveUp?.message).toContain("an UNMEASURED interval");
  });

  it("keeps a real duration, rounded", () => {
    // The counterweight: refusing is for values that say something false, not
    // for a sub-millisecond remainder on a duration measured in hours.
    expect(
      gaveUpWithStalledFor(86_400_000.4)?.diagnostics?.syncLaneGaveUp
        ?.stalledForMs
    ).toBe(86_400_000);
  });

  it("OMITS a magnitude past the safe-integer range", () => {
    // The one refusal the other three do not reach, and the one that gets
    // written: this value is finite, non-negative and survives `Math.round`, and
    // `Number.isInteger` reports true for it - so the cloud mirror's
    // `.int().nonnegative()` accepts it as readily as a real duration and an
    // operator reads a measurement. Past this bound a double holds no
    // consecutive integers, so it is no more a count of milliseconds than a
    // `NaN` is.
    const gaveUp = gaveUpWithStalledFor(Number.MAX_SAFE_INTEGER + 1);

    expect(gaveUp?.diagnostics?.syncLaneGaveUp?.stalledForMs).toBeUndefined();
    expect(gaveUp?.message).toContain("an UNMEASURED interval");
  });

  it("keeps the safe-integer boundary itself", () => {
    // Pins the BOUND and not merely a magnitude somewhere past it: the largest
    // exactly-representable integer is still a measurement, so a guard that
    // refused it would be discarding real values to catch fabricated ones.
    expect(
      gaveUpWithStalledFor(Number.MAX_SAFE_INTEGER)?.diagnostics?.syncLaneGaveUp
        ?.stalledForMs
    ).toBe(Number.MAX_SAFE_INTEGER);
  });
});
