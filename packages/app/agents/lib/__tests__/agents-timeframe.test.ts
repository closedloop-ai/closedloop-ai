import { describe, expect, it } from "vitest";
import {
  AgentsTimeRange,
  getAgentsPrecedingRangeIso,
  getAgentsRangeStartIso,
} from "../agents-timeframe";

const NOW = new Date("2026-07-14T00:00:00.000Z");

describe("getAgentsRangeStartIso", () => {
  it("returns undefined for the 'all' window", () => {
    expect(getAgentsRangeStartIso(AgentsTimeRange.All, NOW)).toBeUndefined();
  });

  it("returns the correct lower bound for 30/60/90 day windows", () => {
    expect(getAgentsRangeStartIso(AgentsTimeRange.Last30Days, NOW)).toBe(
      "2026-06-14T00:00:00.000Z"
    );
    expect(getAgentsRangeStartIso(AgentsTimeRange.Last60Days, NOW)).toBe(
      "2026-05-15T00:00:00.000Z"
    );
    expect(getAgentsRangeStartIso(AgentsTimeRange.Last90Days, NOW)).toBe(
      "2026-04-15T00:00:00.000Z"
    );
  });
});

// FEA-3178: the preceding equivalent window for the period-over-period delta.
describe("getAgentsPrecedingRangeIso", () => {
  it("returns undefined for the 'all' window (no finite prior period)", () => {
    expect(
      getAgentsPrecedingRangeIso(AgentsTimeRange.All, NOW)
    ).toBeUndefined();
  });

  it("returns a same-duration window whose end == the current window's start", () => {
    // 30-day window: current is [2026-06-14, now]; preceding is
    // [2026-05-15, 2026-06-14] — prevEnd equals the current window's startDate.
    const prev = getAgentsPrecedingRangeIso(AgentsTimeRange.Last30Days, NOW);
    expect(prev).toEqual({
      prevStart: "2026-05-15T00:00:00.000Z",
      prevEnd: "2026-06-14T00:00:00.000Z",
    });
    // prevEnd must equal the current window's startDate exactly (no overlap,
    // no gap) so the two windows tile the timeline back-to-back.
    expect(prev?.prevEnd).toBe(
      getAgentsRangeStartIso(AgentsTimeRange.Last30Days, NOW)
    );
  });

  it("shifts a 90-day window back by a full 90 days", () => {
    // current start = now - 90d = 2026-04-15; preceding = [now-180d, now-90d].
    // prevEnd is asserted exactly against the current window's startDate;
    // prevStart is derived by the same calendar-day subtraction the helper uses
    // (local-tz `setDate`, so it can carry an offset across a DST boundary —
    // matching `getAgentsRangeStartIso`, which is fine since both bounds share
    // the identical construction).
    const expectedPrevStart = (() => {
      const d = new Date(NOW);
      d.setDate(d.getDate() - 180);
      return d.toISOString();
    })();
    expect(getAgentsPrecedingRangeIso(AgentsTimeRange.Last90Days, NOW)).toEqual(
      {
        prevStart: expectedPrevStart,
        prevEnd: getAgentsRangeStartIso(AgentsTimeRange.Last90Days, NOW),
      }
    );
  });
});
