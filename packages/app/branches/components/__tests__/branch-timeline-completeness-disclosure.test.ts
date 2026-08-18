import { describe, expect, it } from "vitest";
import {
  makeBranchDetail,
  makeBranchSession,
} from "../../__tests__/branch-fixtures";
import { buildActorColorDomain } from "../../lib/branch-actor-domain";
import { buildSessionTimeline } from "../../lib/branch-session-buckets";
import { formatTimelineCompletenessDisclosure } from "../branch-pr-activity-timeline-helpers";

const DAY_MS = 86_400_000;

describe("formatTimelineCompletenessDisclosure", () => {
  // The disclosure states the span cap in days. Deriving the expected day count
  // from the span the timeline ACTUALLY rendered (rather than re-typing 90) is
  // what makes this fail if the sentence and `MAX_TIMELINE_DAYS` ever disagree.
  it("names the day cap the timeline actually enforced", () => {
    const timeline = buildSessionTimeline(
      makeBranchDetail({
        estimatedCostUsd: 10,
        sessions: [
          makeBranchSession({
            sessionId: "long-running",
            slug: "SES-LONG",
            startedAt: "2026-01-01T10:00:00.000Z",
            endedAt: "2026-12-01T10:00:00.000Z",
            estimatedCostUsd: 10,
          }),
        ],
      }),
      buildActorColorDomain([])
    );
    const renderedSpanDays =
      ((timeline.endMs ?? 0) - (timeline.startMs ?? 0)) / DAY_MS;

    expect(
      timeline.truncatedSessions.map((session) => session.sessionId)
    ).toEqual(["long-running"]);
    expect(
      formatTimelineCompletenessDisclosure([], timeline.truncatedSessions)
    ).toBe(
      `* The ${renderedSpanDays}-day timeline limit omits later activity for SES-LONG. Cost and duration include only rendered activity with timing data.`
    );
  });

  it("returns null when no loaded Session activity was omitted", () => {
    expect(formatTimelineCompletenessDisclosure([], [])).toBeNull();
  });
});
