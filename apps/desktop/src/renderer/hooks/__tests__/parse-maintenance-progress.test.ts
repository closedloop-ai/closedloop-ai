/**
 * @file parse-maintenance-progress.test.ts
 * @description ISS-6241 — the IPC boundary for the maintenance counts.
 *
 * This is the regression suite for the boundary-strip trap: the renderer reads
 * `getRuntimeStatus()` as `unknown`, so a validator that has not been taught a
 * field silently drops it, the feature works in-process, and the producer's own
 * tests stay green. It also holds the honesty line — a payload that cannot
 * substantiate a population must degrade to the indeterminate state, never to a
 * synthesized zero.
 */
import { describe, expect, it } from "vitest";
import { parseMaintenanceProgress } from "../parse-maintenance-progress";

describe("parseMaintenanceProgress (ISS-6241)", () => {
  it("round-trips the counts a live rebuild sends", () => {
    // The trap this exists for: if the boundary schema does not know these keys,
    // they are stripped here and the Compute step renders indeterminate forever
    // while the main process is faithfully reporting them.
    expect(
      parseMaintenanceProgress({
        active: true,
        phase: "rebuild",
        processed: 412,
        total: 1299,
      })
    ).toEqual({ active: true, phase: "rebuild", processed: 412, total: 1299 });
  });

  it("keeps the phase but drops both counts when the payload has none", () => {
    // An older main process, or the artifact-link phase, which has no progress
    // channel out of the db host. The step stays live and reads indeterminate.
    const parsed = parseMaintenanceProgress({
      active: true,
      phase: "artifact-links",
    });

    expect(parsed).toEqual({ active: true, phase: "artifact-links" });
    expect(parsed).not.toHaveProperty("processed");
    expect(parsed).not.toHaveProperty("total");
  });

  it.each([
    ["a lone total", { total: 1299 }],
    ["a lone processed", { processed: 412 }],
  ])("drops %s rather than pairing it with a fabricated counterpart", (_, half) => {
    const parsed = parseMaintenanceProgress({
      active: true,
      phase: "rebuild",
      ...half,
    });

    expect(parsed).toEqual({ active: true, phase: "rebuild" });
  });

  it("rejects a zero total instead of admitting a 0/0", () => {
    // ISS-5932 in one line: a zero denominator is what a displayed 100% was once
    // derived from. It is not a population, so it must not survive the boundary.
    expect(
      parseMaintenanceProgress({
        active: true,
        phase: "rebuild",
        processed: 0,
        total: 0,
      })
    ).toEqual({ active: true, phase: "rebuild" });
  });

  it("rejects a numerator that outruns its denominator", () => {
    // Would render as more-than-complete. The two sub-passes of the rebuild can
    // touch the same session, which is exactly how a naive producer would
    // produce this.
    expect(
      parseMaintenanceProgress({
        active: true,
        phase: "rebuild",
        processed: 1300,
        total: 1299,
      })
    ).toEqual({ active: true, phase: "rebuild" });
  });

  it.each([
    ["a negative count", { processed: -1, total: 10 }],
    ["a fractional count", { processed: 1.5, total: 10 }],
    ["a non-finite total", { processed: 1, total: Number.POSITIVE_INFINITY }],
    ["a NaN total", { processed: 1, total: Number.NaN }],
    ["a stringified count", { processed: "412", total: "1299" }],
  ])("degrades to indeterminate on %s", (_, counts) => {
    expect(
      parseMaintenanceProgress({ active: true, phase: "rebuild", ...counts })
    ).toEqual({ active: true, phase: "rebuild" });
  });

  it("keeps a payload from a NEWER main process that carries unknown fields", () => {
    // Deliberately non-strict: rejecting the whole object over one unknown key
    // would take the phase label down with it and freeze the splash on a stale
    // value during exactly the version skew this app ships into.
    expect(
      parseMaintenanceProgress({
        active: true,
        phase: "rebuild",
        processed: 7,
        total: 9,
        someFuturePhaseDetail: { nested: true },
      })
    ).toEqual({ active: true, phase: "rebuild", processed: 7, total: 9 });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "rebuild"],
    ["an object missing active", { phase: "rebuild" }],
  ])("returns null for %s", (_, payload) => {
    expect(parseMaintenanceProgress(payload)).toBeNull();
  });

  describe("phase ownership of the counts (shafty023 review)", () => {
    it("drops both counts when a phase with no progress channel carries them", () => {
      // The defect: validating the NUMBERS said nothing about WHICH phase owns
      // them, so this pairing passed the boundary and rendered as real progress
      // beside Links — a phase that measures nothing. Only `rebuild` has a
      // progress channel, so only `rebuild` may carry counts.
      const parsed = parseMaintenanceProgress({
        active: true,
        phase: "artifact-links",
        processed: 1,
        total: 10,
      });

      expect(parsed).toEqual({ active: true, phase: "artifact-links" });
      expect(parsed).not.toHaveProperty("processed");
      expect(parsed).not.toHaveProperty("total");
    });

    it("drops counts that ride an INACTIVE payload", () => {
      // Nothing is running, so there is no phase to attribute a population to.
      expect(
        parseMaintenanceProgress({
          active: false,
          phase: "rebuild",
          processed: 5,
          total: 10,
        })
      ).toEqual({ active: false, phase: null });
    });
  });

  describe("phase-vocabulary version skew (shafty023 review)", () => {
    /**
     * This block replaces an expectation that a payload naming an unknown phase
     * parses to `null`. That expectation was asserting the WRONG contract, not
     * merely a different one: `null` is read downstream as "no maintenance", so
     * a newer main process reporting a phase this build predates turned LIVE
     * maintenance into "finished" and let the banner collapse mid-rebuild.
     * Unknown FIELDS were already forward-compatible; the phase vocabulary was
     * not. Liveness is now preserved and only the unsupported detail degrades.
     */
    it("preserves active:true for a phase this build has never heard of", () => {
      expect(
        parseMaintenanceProgress({ active: true, phase: "defragmenting" })
      ).toEqual({ active: true, phase: null });
    });

    it("degrades an unknown phase's counts too, without reporting it finished", () => {
      // The counts cannot be attributed to a phase we cannot name, so they go —
      // but `active` survives, which is the whole point: the banner must not
      // collapse over a vocabulary gap.
      const parsed = parseMaintenanceProgress({
        active: true,
        phase: "defragmenting",
        processed: 3,
        total: 12,
      });

      expect(parsed).toEqual({ active: true, phase: null });
      expect(parsed?.active).toBe(true);
    });

    it("still reports an unknown phase as finished once the producer says so", () => {
      // The skew degrade must not latch liveness ON either — `active` is read
      // from the payload, never inferred from the phase being unrecognised.
      expect(
        parseMaintenanceProgress({ active: false, phase: "defragmenting" })
      ).toEqual({ active: false, phase: null });
    });
  });
});
