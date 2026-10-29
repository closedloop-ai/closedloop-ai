import type {
  ActivityBucket,
  AgentSessionDetail,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  TIMELINE_SCALE_OPTIONS,
  TimelineScale,
} from "@repo/app/agents/lib/session-timeline-scale";
import { formatCostPrecise } from "@repo/app/shared/lib/format-utils";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createAgentSessionDetailFixture,
  withProducerBinBounds,
} from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import { SESSION_TIMELINE_TOTAL_TOKENS_UNIT } from "../session-property-labels";
import {
  timelinePeakBucketExplanation,
  timelinePeakBucketLabel,
} from "../timeline-peak-bucket-fact";
import {
  resetTraceComments,
  withProviders,
} from "./agent-session-detail-view.test-helpers";

/**
 * ISS-12665 — the Session Timeline header states the costliest column at the
 * strip's current scale, as the generic-artifact prototype's header does.
 *
 * Driven through `AgentSessionDetailView`, the production entry point both
 * shells mount, so the assertions cover the wiring from the scale hook through
 * the heading to the summary, not the leaf alone.
 *
 * UTC is pinned so each 12-hour source bin lands on exactly one `12h` column.
 */

const originalTimezone = process.env.TZ;
const FIXED_NOW = new Date("2026-07-10T12:00:00.000Z");
const SESSION_START = new Date("2026-06-10T00:00:00.000Z");
const HOUR_MS = 3_600_000;
const BIN_COUNT = 40;
const SESSION_MS = BIN_COUNT * 12 * HOUR_MS;
/** Day 17.5 — outside the opening `12h` window, which covers twelve days. */
const LATE_PEAK_INDEX = 35;
const PEAK_12H_NAME = `${timelinePeakBucketLabel(TimelineScale.TwelveHours)} ${formatCostPrecise(9)}`;
const PEAK_1H_NAME = `${timelinePeakBucketLabel(TimelineScale.OneHour)} ${formatCostPrecise(9 / 12)}`;
const ANY_MONEY_RE = /\$/;
const EM_DASH = "—";

beforeAll(() => {
  process.env.TZ = "UTC";
});

afterAll(() => {
  if (originalTimezone === undefined) {
    Reflect.deleteProperty(process.env, "TZ");
    return;
  }
  process.env.TZ = originalTimezone;
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  resetTraceComments();
});

describe("the Session Timeline header states its peak column", () => {
  it("prints the whole-session peak, not the opening window's tallest bar", () => {
    renderDetail(longSession());

    expect(
      screen.getByRole("button", { name: PEAK_12H_NAME })
    ).toBeInTheDocument();
  });

  it("recomputes at the scale the reader picks", () => {
    renderDetail(longSession());

    fireEvent.click(screen.getByRole("radio", { name: "1h timeline scale" }));

    expect(
      screen.getByRole("button", { name: PEAK_1H_NAME })
    ).toBeInTheDocument();
  });

  it("explains itself from the keyboard with the prototype's sentence", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderDetail(longSession());
    const trigger = screen.getByRole("button", { name: PEAK_12H_NAME });

    while (document.activeElement !== trigger) {
      await user.tab();
    }
    const tooltip = await screen.findByRole("tooltip");

    expect(tooltip).toHaveTextContent(
      timelinePeakBucketExplanation(TimelineScale.TwelveHours)
    );
  });

  it("keeps the cost, tokens and elapsed facts beside it", () => {
    renderDetail(longSession());
    const heading = screen.getByRole("heading", { name: "Session Timeline" });
    const header = heading.parentElement;

    expect(header).toHaveTextContent("cost");
    expect(header).toHaveTextContent(SESSION_TIMELINE_TOTAL_TOKENS_UNIT);
    expect(header).toHaveTextContent("elapsed");
  });

  it("shows a dash, never a figure, when the strip's costs are synthesized", () => {
    renderDetail(synthesizedSession());
    const trigger = screen.getByRole("button", {
      name: `${timelinePeakBucketLabel(TimelineScale.FiveMinutes)} ${EM_DASH}`,
    });

    expect(trigger.textContent).not.toMatch(ANY_MONEY_RE);
  });

  it("draws no peak when there is no strip to scale", () => {
    renderDetail(
      createAgentSessionDetailFixture({
        activityBuckets: [],
        markers: [],
        name: "No activity",
        turnItems: [],
      })
    );

    for (const scale of TIMELINE_SCALE_OPTIONS) {
      expect(
        screen.queryByText(timelinePeakBucketLabel(scale), { exact: false })
      ).toBeNull();
    }
  });
});

function renderDetail(session: AgentSessionDetail) {
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

function longSession(): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    activityBuckets: withProducerBinBounds(bins(), {
      endMs: SESSION_START.getTime() + SESSION_MS,
      startMs: SESSION_START.getTime(),
    }),
    activitySegmentRows: [
      {
        confidence: 1,
        endMs: SESSION_START.getTime() + SESSION_MS,
        evidenceLayers: ["declared"],
        phase: "implement",
        startMs: SESSION_START.getTime(),
        version: 1,
      },
    ],
    endedAt: new Date(SESSION_START.getTime() + SESSION_MS),
    lastActivityAt: new Date(SESSION_START.getTime() + SESSION_MS),
    name: "Peak column session",
    startedAt: SESSION_START,
    status: SESSION_STATUS.INACTIVE,
  });
}

/**
 * No persisted buckets and no real total, so the strip is synthesized from the
 * transcript and every figure on it would be the synthesizer's one-cent floor
 * (`hasSynthesizedBucketCosts`).
 */
function synthesizedSession(): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    activityBuckets: [],
    endedAt: new Date("2026-06-10T12:20:00.000Z"),
    estimatedCost: 0,
    markers: [],
    name: "Synthesized peak session",
    startedAt: new Date("2026-06-10T12:00:00.000Z"),
    turnItems: [
      promptRow(0, "2026-06-10T12:01:00.000Z"),
      promptRow(1, "2026-06-10T12:16:00.000Z"),
    ],
  });
}

function promptRow(row: number, at: string): TurnItem {
  return {
    _row: row,
    actor: {
      color: "var(--primary)",
      harness: "codex",
      human: null,
      name: "gpt-5.5",
      sessionId: "session-iss-12665",
    },
    cum: 0,
    t: at,
    tMs: Date.parse(at),
    text: `turn ${row}`,
    type: "prompt",
  };
}

function bins(): ActivityBucket[] {
  return Array.from({ length: BIN_COUNT }, (_, index) => {
    const cost = index === LATE_PEAK_INDEX ? 9 : 1;
    return {
      byModel: { "claude-opus-5": { cCache: 0, cIn: cost, cOut: 0 } },
      cCache: 0,
      cIn: cost,
      cOut: 0,
      key: `bin-${index}`,
      label: `bin ${index}`,
      tl0: index,
      toolStart: 0,
      total: 1,
    };
  });
}
