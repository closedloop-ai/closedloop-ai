import type {
  ActivityBucket,
  AgentSessionDetail,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import { SESSION_TIMELINE_SOURCE_EXTENT_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TIMELINE_UNMEASURED_INTERVAL_TOOLTIP } from "../activity-bucket-rendering";
import {
  createAgentSessionDetailFixture,
  withProducerBinBounds,
} from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";

/**
 * ISS-5850: the Session Timeline must not present an interval the collector
 * never measured as one it measured and found quiet.
 *
 * THE DISCRIMINATOR is a session whose collector extent is NARROWER than the
 * window the strip draws — 12:05–12:10 of bins, rendered across a 24-column
 * `5m` window that starts at 12:00. Where the two agree there is no bug to see,
 * so a fixture whose bins span the window would pass identically against the
 * broken code; this one cannot.
 *
 * Every case pairs a positive with its negative in the same suite, because each
 * negative is a way this fix could be faked:
 *  - a covered column must NOT carry the line (else "withhold everything"),
 *  - the flag OFF must NOT carry it (the ISS-4779 closed default),
 *  - a session whose producer stated no extent must NOT carry it (version
 *    skew — an older desktop build must degrade, not blank).
 *
 * Driven through `AgentSessionDetailView`, the production entry point, rather
 * than through the projection: the projection is unit-tested separately in
 * `session-timeline-source-extent.test.ts`, and what this file is for is proving
 * the answer actually reaches the reader.
 */

const STARTED_AT = "2026-06-10T12:00:00.000Z";
const ENDED_AT = "2026-06-10T12:20:00.000Z";

/** The stretch the collector actually binned — five minutes inside the run. */
const EXTENT_START_MS = Date.parse("2026-06-10T12:05:00.000Z");
const EXTENT_END_MS = Date.parse("2026-06-10T12:10:00.000Z");

const ACTOR = {
  color: "var(--primary)",
  harness: "codex",
  human: null,
  name: "gpt-5.5",
  sessionId: "session-iss-5850",
};

const ANY_BUCKET_NAME_RE = /activity bucket/i;
/**
 * The hover card's meta line. `tool calls` rather than `events`: the Session
 * Trace heading also prints an event count, so only this phrase is unique to
 * the card.
 */
const TOOLTIP_META_RE = /tool calls/;
/** The MEASURED strip's idle line — what an uncovered column used to claim. */
const NO_TOKENS_BILLED_COPY =
  "Agent asleep | scheduled wake-up | no tokens billed";
const EXTENT_FLAGS = [SESSION_TIMELINE_SOURCE_EXTENT_FEATURE_FLAG_KEY];

/**
 * At `5m` the window's columns are 12:00, 12:05, 12:10, … so column 1 is the
 * only one the 12:05–12:10 extent covers, and column 4 (12:20) is comfortably
 * past it. Named rather than inlined so the two indices cannot silently drift
 * apart from the extent above.
 */
const COVERED_COLUMN = 1;
const UNCOVERED_COLUMN = 4;

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

/** Rows across the whole run, so the AXIS window spans more than the extent. */
function transcriptRows(): TurnItem[] {
  return [
    promptRow(0, "2026-06-10T12:01:00.000Z"),
    promptRow(1, "2026-06-10T12:06:00.000Z"),
    promptRow(2, "2026-06-10T12:08:00.000Z"),
    promptRow(3, "2026-06-10T12:18:00.000Z"),
  ];
}

/** Real measured money, binned over the EXTENT rather than over the run. */
function measuredBuckets(): ActivityBucket[] {
  return withProducerBinBounds(
    [
      {
        byModel: { "gpt-5.5": { cCache: 0.4, cIn: 1.1, cOut: 0.6 } },
        cCache: 0.4,
        cIn: 1.1,
        cOut: 0.6,
        key: "measured-0",
        label: "5m",
        tl0: 1,
        toolStart: 1,
        total: 2,
      },
      {
        byModel: { "gpt-5.5": { cCache: 0.3, cIn: 1.7, cOut: 0.72 } },
        cCache: 0.3,
        cIn: 1.7,
        cOut: 0.72,
        key: "measured-1",
        label: "7m",
        tl0: 2,
        toolStart: 1,
        total: 2,
      },
    ],
    { endMs: EXTENT_END_MS, startMs: EXTENT_START_MS }
  );
}

function sessionWithExtent(
  span: AgentSessionDetail["span"] = {
    endMs: EXTENT_END_MS,
    first: "0:00",
    last: "5:00",
    startMs: EXTENT_START_MS,
  }
): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    activityBuckets: measuredBuckets(),
    endedAt: new Date(ENDED_AT),
    estimatedCost: 4.82,
    markers: [],
    name: "Source extent session",
    span,
    startedAt: new Date(STARTED_AT),
    turnItems: transcriptRows(),
  });
}

function renderDetail(session: AgentSessionDetail, enabledFlags: string[]) {
  render(
    <AppCoreStoryProviders enabledFlags={enabledFlags}>
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={session}
      />
    </AppCoreStoryProviders>
  );
}

function timelineBars(): HTMLElement[] {
  return screen.getAllByRole("button", { name: ANY_BUCKET_NAME_RE });
}

async function hoverColumn(index: number) {
  const user = userEvent.setup();
  const bars = timelineBars();
  const bar = bars[index];
  if (!bar) {
    throw new Error(
      `the strip rendered ${bars.length} bars; column ${index} is not among them`
    );
  }
  await user.hover(bar);
}

describe("Session Timeline, collector extent narrower than the window (ISS-5850)", () => {
  it("says an uncovered column was not measured, instead of claiming it was idle", async () => {
    renderDetail(sessionWithExtent(), EXTENT_FLAGS);

    await hoverColumn(UNCOVERED_COLUMN);

    expect(
      screen.getByText(TIMELINE_UNMEASURED_INTERVAL_TOOLTIP)
    ).toBeInTheDocument();
    /*
     * The defect, asserted directly: this column's zeroes previously fell
     * through to the measured idle line, whose "no tokens billed" is a billing
     * claim about an interval the collector never looked at.
     */
    expect(screen.queryByText(NO_TOKENS_BILLED_COPY)).not.toBeInTheDocument();
  });

  it("leaves a COVERED column's readout alone", async () => {
    /*
     * The pair that stops "withhold everything" passing. Same session, same
     * flag, a column the extent does reach — its measured money must survive.
     */
    renderDetail(sessionWithExtent(), EXTENT_FLAGS);

    await hoverColumn(COVERED_COLUMN);

    expect(
      screen.queryByText(TIMELINE_UNMEASURED_INTERVAL_TOOLTIP)
    ).not.toBeInTheDocument();
  });

  it("stays silent with the flag OFF, on the very column it would withhold", async () => {
    // ISS-4779 closed-by-default, proven on the case that would otherwise
    // change — a flag test on a covered column would pass either way.
    renderDetail(sessionWithExtent(), []);

    await hoverColumn(UNCOVERED_COLUMN);

    expect(
      screen.queryByText(TIMELINE_UNMEASURED_INTERVAL_TOOLTIP)
    ).not.toBeInTheDocument();
  });

  it("withholds the event and tool-call counts on an unmeasured column", async () => {
    /*
     * ISS-5850 design review. "0 events | 0 tool calls" is a measured claim
     * about an interval nobody measured, and it used to render one line under
     * the sentence saying nobody measured it — the same defect this ticket
     * removes, in the footer of the card that fixes it. The zeroes are
     * structural (an uncovered column is initialized at zero and never receives
     * a contribution), not observed.
     */
    renderDetail(sessionWithExtent(), EXTENT_FLAGS);

    await hoverColumn(UNCOVERED_COLUMN);

    expect(screen.queryByText(TOOLTIP_META_RE)).not.toBeInTheDocument();
  });

  it("keeps those counts on a column the extent DOES reach", async () => {
    // The positive sibling: withholding must be keyed to coverage, not applied
    // to the whole strip.
    renderDetail(sessionWithExtent(), EXTENT_FLAGS);

    await hoverColumn(COVERED_COLUMN);

    expect(screen.getByText(TOOLTIP_META_RE)).toBeInTheDocument();
  });

  it("states no extent at all when the strip was SYNTHESIZED", () => {
    /*
     * ISS-5850 code review, and the sharpest edge on this change. `session.span`
     * is the DESKTOP COLLECTOR's extent; when `activityBuckets` arrives empty
     * the strip is rebuilt from turn items by a DIFFERENT producer that bins
     * over the whole axis window. Handing the collector's extent to those bins
     * marks columns that are visibly drawing bars "unmeasured" — and because the
     * unmeasured branch is tested first, it also swallows ISS-5566's
     * synthesized-cost disclosure on exactly the strip that disclosure is for.
     */
    const synthesized = createAgentSessionDetailFixture({
      activityBuckets: [],
      endedAt: new Date(ENDED_AT),
      estimatedCost: 4.82,
      markers: [],
      name: "Synthesized strip session",
      span: {
        endMs: EXTENT_END_MS,
        first: "0:00",
        last: "5:00",
        startMs: EXTENT_START_MS,
      },
      startedAt: new Date(STARTED_AT),
      turnItems: transcriptRows(),
    });

    renderDetail(synthesized, EXTENT_FLAGS);

    for (const bar of timelineBars()) {
      expect(bar.getAttribute("aria-label") ?? "").not.toContain(
        TIMELINE_UNMEASURED_INTERVAL_TOOLTIP
      );
    }
  });

  it("stays silent for a producer that stated no extent, flag ON", async () => {
    /*
     * Version skew (AC4/AC5): a desktop build that predates the field sends a
     * span with only its clock offsets. Coverage is then UNKNOWN, and unknown
     * must not be rendered as unmeasured — that would withhold every column on
     * most of the installed base.
     */
    renderDetail(
      sessionWithExtent({ first: "0:00", last: "5:00" }),
      EXTENT_FLAGS
    );

    await hoverColumn(UNCOVERED_COLUMN);

    expect(
      screen.queryByText(TIMELINE_UNMEASURED_INTERVAL_TOOLTIP)
    ).not.toBeInTheDocument();
  });

  it("carries the same fact in the accessible name, not by tooltip alone", () => {
    /*
     * WCAG 1.4.1: a distinction that exists only in a hover card is a
     * distinction a non-pointer reader never receives. One statement per
     * column, in both trees — and the covered column below is what proves the
     * name is derived rather than appended to everything.
     */
    renderDetail(sessionWithExtent(), EXTENT_FLAGS);

    const bars = timelineBars();

    expect(bars[UNCOVERED_COLUMN]?.getAttribute("aria-label")).toContain(
      TIMELINE_UNMEASURED_INTERVAL_TOOLTIP
    );
    expect(bars[COVERED_COLUMN]?.getAttribute("aria-label")).not.toContain(
      TIMELINE_UNMEASURED_INTERVAL_TOOLTIP
    );
  });
});

describe("Session Timeline unmeasured-interval copy, cross-adapter pin", () => {
  it("matches the literal the Electron e2e spec asserts against", () => {
    /*
     * Pins the literal retained by the focused native source-extent E2E case;
     * this assertion alone does not prove cross-adapter execution.
     */
    expect(TIMELINE_UNMEASURED_INTERVAL_TOOLTIP).toBe(
      "Outside the measured stretch of this session"
    );
  });
});
