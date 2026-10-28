import { describe, expect, it } from "vitest";
import {
  getTimelineMarkerSemanticLabel,
  getTimelineMarkerSemanticSort,
  getTimelineMarkerSemanticToken,
  TimelineMarkerSemantic,
} from "../timeline-marker-semantics";

describe("timeline marker semantics", () => {
  it("keeps the shared semantic order stable", () => {
    expect(
      [
        TimelineMarkerSemantic.HumanSteering,
        TimelineMarkerSemantic.Delivery,
        TimelineMarkerSemantic.FailureLimit,
      ].map(getTimelineMarkerSemanticSort)
    ).toEqual([0, 1, 2]);
  });

  it("owns the base labels and color tokens used by rail adapters", () => {
    expect(
      getTimelineMarkerSemanticLabel(TimelineMarkerSemantic.HumanSteering)
    ).toBe("Human steering");
    expect(
      getTimelineMarkerSemanticLabel(TimelineMarkerSemantic.Delivery)
    ).toBe("Commits & PRs");
    expect(
      getTimelineMarkerSemanticLabel(TimelineMarkerSemantic.FailureLimit)
    ).toBe("Failures & limits");
    expect(
      getTimelineMarkerSemanticToken(TimelineMarkerSemantic.HumanSteering)
    ).toBe("var(--primary)");
    expect(
      getTimelineMarkerSemanticToken(TimelineMarkerSemantic.Delivery)
    ).toBe("var(--success)");
    expect(
      getTimelineMarkerSemanticToken(TimelineMarkerSemantic.FailureLimit)
    ).toBe("var(--destructive)");
  });
});
