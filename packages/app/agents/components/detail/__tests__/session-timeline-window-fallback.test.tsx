import type {
  ActivityBucket,
  AgentSessionDetail,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  createAgentSessionDetailFixture,
  withProducerBinBounds,
} from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";

/**
 * ISS-8771 — what the reader actually SEES when the 24-bucket projection could
 * not run.
 *
 * `use-session-timeline-scale.test.tsx` pins the hook's answer; this pins that
 * the answer reaches the screen, through `AgentSessionDetailView`, the
 * production entry point both surfaces mount. The two cases below are one
 * fixture differing in ONE fact — whether its bins carry the producer bounds
 * that say which clock they were measured on — so neither can pass for the
 * reason the other does:
 *
 *  - without bounds: the producer's own bars, and NO controls. The strip must
 *    not offer a scale toggle it cannot honour, nor imply a projection ran.
 *  - with bounds: the same bins, the same window, now 24 columns and a live
 *    toggle. Without this sibling the absence assertion above would also be
 *    satisfied by a component that failed to render at all.
 */

const STARTED_AT = "2026-06-10T12:00:00.000Z";
const ENDED_AT = "2026-06-10T12:35:00.000Z";
const WINDOW = {
  endMs: Date.parse(ENDED_AT),
  startMs: Date.parse(STARTED_AT),
};

/**
 * Seven, chosen because it is neither 24 nor a factor of it: a fallback strip
 * drawing the producer's bars and a projected strip drawing the window are then
 * distinguishable by count alone.
 */
const PRODUCER_BIN_COUNT = 7;
const SCALE_CONTROL_NAME = "Timeline scale";
const GROUP_BY_CONTROL_NAME = /group by/i;
const ANY_BUCKET_NAME_RE = /activity bucket/i;

const ACTOR = {
  color: "var(--primary)",
  harness: "codex",
  human: null,
  name: "gpt-5.5",
  sessionId: "session-iss-8771",
};

function producerBins(): ActivityBucket[] {
  return Array.from({ length: PRODUCER_BIN_COUNT }, (_, index) => ({
    byModel: { "gpt-5.5": { cCache: 0.2, cIn: 0.9, cOut: 0.4 } },
    cCache: 0.2,
    cIn: 0.9,
    cOut: 0.4,
    key: `producer-${index}`,
    label: `bin ${index}`,
    tl0: index,
    toolStart: 1,
    total: 2,
  }));
}

function promptRow(row: number, at: string): TurnItem {
  return {
    _row: row,
    actor: ACTOR,
    cum: 0,
    t: at,
    tMs: Date.parse(at),
    text: `turn ${row}`,
    type: "prompt",
  };
}

function sessionWith(buckets: ActivityBucket[]): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    activityBuckets: buckets,
    endedAt: new Date(ENDED_AT),
    estimatedCost: 3.85,
    markers: [],
    name: "Window contract session",
    span: {
      endMs: WINDOW.endMs,
      first: "0:00",
      last: "35:00",
      startMs: WINDOW.startMs,
    },
    startedAt: new Date(STARTED_AT),
    turnItems: [
      promptRow(0, "2026-06-10T12:01:00.000Z"),
      promptRow(1, "2026-06-10T12:20:00.000Z"),
      promptRow(2, "2026-06-10T12:33:00.000Z"),
    ],
  });
}

function renderDetail(session: AgentSessionDetail) {
  render(
    <AppCoreStoryProviders enabledFlags={[]}>
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={session}
      />
    </AppCoreStoryProviders>
  );
}

describe("Session Timeline when the 24-bucket projection cannot run", () => {
  it("draws the producer's own bars and offers no window controls", () => {
    renderDetail(sessionWith(producerBins()));

    expect(
      screen.getAllByRole("button", { name: ANY_BUCKET_NAME_RE })
    ).toHaveLength(PRODUCER_BIN_COUNT);
    expect(
      screen.queryByRole("radiogroup", { name: SCALE_CONTROL_NAME })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: GROUP_BY_CONTROL_NAME })
    ).not.toBeInTheDocument();
  });

  it("draws 24 bars and a live scale toggle once the bins carry bounds", () => {
    renderDetail(sessionWith(withProducerBinBounds(producerBins(), WINDOW)));

    // 24 written out, not imported from `TIMELINE_VISIBLE_COLUMNS`: a case that
    // reads its expectation from the constant it guards cannot fail when that
    // constant moves.
    expect(
      screen.getAllByRole("button", { name: ANY_BUCKET_NAME_RE })
    ).toHaveLength(24);
    expect(
      screen.getByRole("radiogroup", { name: SCALE_CONTROL_NAME })
    ).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: GROUP_BY_CONTROL_NAME })
    ).toBeVisible();
  });
});
