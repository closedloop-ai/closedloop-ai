import { describe, expect, it } from "vitest";
import { formatDuration, sessionRows } from "./mock";
import { buildSessionDetail } from "./mock-detail";

describe("formatDuration", () => {
  it.each([
    [0, "0s"],
    [3000, "3s"],
    [9 * 60_000 + 27_000, "9m 27s"],
    [62 * 60_000 + 12_000, "1h 2m"],
  ])("formats %i milliseconds as %s", (durationMs, expected) => {
    expect(formatDuration(durationMs)).toBe(expected);
  });
});

describe("session timeline fixtures", () => {
  it("places token cost at every event-marker timestamp", () => {
    for (const row of sessionRows) {
      const detail = buildSessionDetail(row);
      for (const marker of detail.timelineMarkers) {
        const costAtMarker = detail.costEvents
          .filter((event) => event.atMinutes === marker.atMinutes)
          .reduce(
            (sum, event) => sum + event.cIn + event.cOut + event.cCache,
            0
          );
        expect(
          costAtMarker,
          `${row.name}: ${marker.kind} at ${marker.atMinutes}m`
        ).toBeGreaterThan(0);
      }
    }
  });
});
