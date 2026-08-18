import { describe, expect, it } from "vitest";
import { normalizeActivitySegmentEvidenceLayers } from "./agent-session-activity-evidence.ts";

describe("normalizeActivitySegmentEvidenceLayers", () => {
  it("keeps only string entries from an evidence layer array", () => {
    expect(
      normalizeActivitySegmentEvidenceLayers([
        "transcript",
        null,
        7,
        "tool-usage",
      ])
    ).toEqual(["transcript", "tool-usage"]);
  });

  it("returns an empty array for a non-array value", () => {
    expect(normalizeActivitySegmentEvidenceLayers("transcript")).toEqual([]);
  });
});
