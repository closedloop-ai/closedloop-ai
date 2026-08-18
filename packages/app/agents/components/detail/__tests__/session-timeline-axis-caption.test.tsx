import {
  SESSION_TIMELINE_AXIS_SPAN_PREFIX,
  SESSION_TIMELINE_AXIS_SPAN_TITLE,
} from "@repo/app/agents/lib/session-duration";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  createAgentSessionDetailFixture,
  createTurnItemsSpanning,
} from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import { withProviders } from "./agent-session-detail-view.test-helpers";

// ISS-4675: the Session Timeline AXIS ROW — start tick, qualified total, end
// tick — is now its own component (`session-timeline-axis.tsx`), so its caption
// contract gets its own suite instead of living in the 3,000-line composed
// `agent-session-detail-view.test.tsx`. It still mounts the COMPOSED view: the
// defect this pins only exists when the axis total is read on the same screen as
// the Duration card it used to contradict.
//
// Shared verbatim by web and desktop through `@repo/app`, so pinning the
// composed view pins both surfaces.

const AXIS_LABEL_SELECTOR = ".sd3-act-span";
const AXIS_ROW_SELECTOR = ".sd3-act-axis";

/**
 * The still-running session both ISS-4675 cases below describe: work from 10:00
 * to 14:54, never ended. Its transcript is re-timed onto that same window
 * (`createTurnItemsSpanning`) because the axis measures the rows it plots — a
 * fixture that moved only the lifecycle stamps would leave the default
 * 12:01–12:04 rows behind and the axis would report THEIR span instead.
 */
const RUNNING_STARTED_AT = "2026-06-10T10:00:00.000Z";
const RUNNING_LAST_ACTIVITY_AT = "2026-06-10T14:54:00.000Z";

function createRunningSessionFixture() {
  return createAgentSessionDetailFixture({
    startedAt: new Date(RUNNING_STARTED_AT),
    lastActivityAt: new Date(RUNNING_LAST_ACTIVITY_AT),
    endedAt: null,
    wallClock: "3h 33m",
    turnItems: createTurnItemsSpanning(
      RUNNING_STARTED_AT,
      RUNNING_LAST_ACTIVITY_AT
    ),
  });
}

function renderDetail(
  session: ReturnType<typeof createAgentSessionDetailFixture>
) {
  return render(
    withProviders(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={session}
      />
    )
  );
}

describe("session timeline axis caption", () => {
  it("ISS-4684: renders the axis total in the Activity-phases unit system (supersedes the FEA-2029 rounded-up-minutes label)", () => {
    const startedAt = "2026-06-10T12:00:00.000Z";
    const endedAt = "2026-06-10T12:05:05.000Z";
    renderDetail(
      createAgentSessionDetailFixture({
        startedAt: new Date(startedAt),
        lastActivityAt: new Date(endedAt),
        endedAt: new Date(endedAt),
        // The axis plots the transcript, so the transcript has to be the one
        // this session declares — see `createTurnItemsSpanning`.
        turnItems: createTurnItemsSpanning(startedAt, endedAt),
      })
    );

    // 12:00:00 -> 12:05:05 is 5m 5s. FEA-2029 rendered this as a rounded-up
    // whole-minute SCALE claim ("6m"); ISS-4684 deliberately supersedes that,
    // rendering the honest span through the SAME `formatDuration` the
    // "Activity phases" caption below it uses, so the two totals read in one
    // unit system instead of the reader doing the conversion by eye. The
    // rounded-up `getDurationScaleMinutes` contract itself still stands and
    // stays covered in `shared/lib/__tests__/format-utils.test.ts`.
    const axisScale = document.querySelector<HTMLElement>(AXIS_LABEL_SELECTOR);
    expect(axisScale).toHaveTextContent("5m 5s");
    expect(axisScale).not.toHaveTextContent("6m");
    expect(axisScale).toHaveAttribute(
      "title",
      SESSION_TIMELINE_AXIS_SPAN_TITLE
    );
  });

  it("ISS-4675: names the axis total so it cannot read as a second, contradicting Duration", () => {
    // The card above leads with the observed-running wallClock (3h 33m) while the
    // axis plots 4h 54m of calendar time. Both numbers are correct; an
    // unqualified axis total made them look like a contradiction. The axis is a
    // calendar time axis by construction (every dot is a fraction of
    // startedAt -> axis end), so it is captioned rather than re-scaled.
    renderDetail(createRunningSessionFixture());

    const axisScale = document.querySelector<HTMLElement>(AXIS_LABEL_SELECTOR);
    // The axis keeps its own calendar measure...
    expect(axisScale).toHaveTextContent("4h 54m");
    // ...and now says which measure that is, QUALIFIER FIRST so it scans as a
    // set with the "phases span <dur>" caption directly below it.
    expect(axisScale).toHaveTextContent(
      `${SESSION_TIMELINE_AXIS_SPAN_PREFIX} 4h 54m`
    );
    // ...and its hover explanation supplements (never replaces) that label.
    expect(axisScale).toHaveAttribute(
      "title",
      SESSION_TIMELINE_AXIS_SPAN_TITLE
    );
  });

  it("ISS-4675: puts the session's END instant on the right tick, not the span", () => {
    // The right end of an axis is where the eye looks for the end time. The
    // qualified total used to sit there while `span.last` was computed and
    // rendered nowhere, and an empty decorative span occupied the middle slot.
    // The row must read start, span, end.
    renderDetail(createRunningSessionFixture());

    const axisRow = document.querySelector<HTMLElement>(AXIS_ROW_SELECTOR);
    const slots = [...(axisRow?.children ?? [])];
    expect(slots).toHaveLength(3);
    // The middle slot is the qualified total (no longer an empty decoration)...
    expect(slots[1]).toHaveTextContent(SESSION_TIMELINE_AXIS_SPAN_PREFIX);
    // ...and the right slot carries a real end instant, not a duration.
    expect(slots[2]?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    expect(slots[2]).not.toHaveTextContent(SESSION_TIMELINE_AXIS_SPAN_PREFIX);
  });
});
