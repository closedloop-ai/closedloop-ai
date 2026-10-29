import type {
  AgentSessionDetail,
  SessionThrottle,
  SyncedAgentSessionEvent,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import { SessionTraceThrottleSourceType } from "@repo/api/src/types/agent-session";
import { resolveSessionTimelineWindow } from "@repo/app/agents/lib/session-timeline-geometry";
import { TraceScrollOutcome } from "@repo/app/agents/lib/trace-scroll-target";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { getDotJumpRow } from "../activity-dot-rendering";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import {
  buildActivityMarkers,
  buildLimitDotEvents,
} from "../session-activity-markers";
import { buildDotCells } from "../session-timeline-dot-cells";
import { SessionTimelineDotRail } from "../session-timeline-dot-rail";
import { createDotRailStageBuckets } from "../session-trace-scenario-fixture";
import { makeTimelineBucket } from "./session-timeline-scroll-harness";

/**
 * ISS-8721: on the ORDINAL FALLBACK path the two dot sources had no common
 * scale, so the trouble lane's first member — the row the rail's click targets —
 * was decided by comparing a turn's rank against a wall-clock fraction.
 *
 * A session with no persisted `markers` builds its markers from `buildTurnMarker`,
 * whose `x` is `index / (total - 1)`, while every limit dot's `x` is that
 * instant's fraction of the timeline window. Both cases below are built so those
 * two numbers RANK THE PAIR DIFFERENTLY FROM THE CLOCK — that disagreement is
 * the whole test, and a fixture where they agree proves nothing.
 *
 * The pair also rules out the order ISS-8657 replaced. Kind priority (every
 * failure, then every limit) happens to be right in the first case and is wrong
 * in the second, so restoring it cannot pass both.
 */

const SESSION_START_MS = Date.parse("2026-06-10T09:00:00.000Z");
const MINUTE_MS = 60_000;
const BUCKET_COUNT = 1;
const FAIL_SUMMARY = "Ran 3 tools";

const AGENT_ACTOR = {
  name: "gpt-5.5",
  sessionId: "dot-lane-session",
  human: null,
  color: "var(--primary)",
  harness: "codex",
};
const HUMAN_ACTOR = {
  name: null,
  sessionId: "dot-lane-session",
  human: "Ada Lovelace",
  color: "var(--chart-2)",
};

/*
 * The failure fires at +1m and the limit at +30m, so the CLOCK says failure
 * first. The failure is turn 2 of 5, so its ordinal `x` is 50 against the
 * limit's 30% window fraction, and plotted position says limit first.
 *
 * Kind priority also says failure first here, which is why the sibling case
 * below exists.
 */
const FAILURE_FIRST_TURNS: TurnItem[] = [
  promptTurn(0, 0, "Typecheck the affected slice."),
  promptTurn(1, 0.5, "Start with the desktop package."),
  failingToolTurn(2, 1),
  promptTurn(3, 30, "Now retry the failing command."),
  promptTurn(4, 100, "Summarise what broke."),
];
const FAILURE_FIRST_LIMIT_AT_MINUTE = 30;
/** The transcript row the +30m limit dot anchors to — the turn at that instant. */
const FAILURE_FIRST_LIMIT_ROW = 3;
/** The failing tool turn's own row. */
const FAILURE_FIRST_FAIL_ROW = 2;

/*
 * The mirror: the limit fires at +50m and the failure at +60m, so the CLOCK says
 * limit first. The failure is turn 3 of 6, so its ordinal `x` is 40 against the
 * limit's 50% window fraction, and plotted position says failure first.
 *
 * Kind priority says failure first too, so it is wrong here.
 */
const LIMIT_FIRST_TURNS: TurnItem[] = [
  promptTurn(0, 0, "Typecheck the affected slice."),
  promptTurn(1, 50, "Keep going once the limit clears."),
  failingToolTurn(2, 60),
  promptTurn(3, 61, "Retry the failing command."),
  promptTurn(4, 62, "Check the second package."),
  promptTurn(5, 100, "Summarise what broke."),
];
const LIMIT_FIRST_LIMIT_AT_MINUTE = 50;
const LIMIT_FIRST_LIMIT_ROW = 1;
const LIMIT_FIRST_FAIL_ROW = 2;

/*
 * Two buckets, and a THIRD trouble dot dated past the window so it plots at 100
 * and lands in the second one. The failure (+2m, turn 2 of 5, ordinal `x` 25)
 * and the in-window limit (+20m, window fraction 20) both land in the first,
 * where the clock and plotted position again disagree.
 */
const POISON_BUCKET_COUNT = 2;
const POISON_TURNS: TurnItem[] = [
  promptTurn(0, 0, "Typecheck the affected slice."),
  failingToolTurn(1, 2),
  promptTurn(2, 20, "Retry once the limit clears."),
  promptTurn(3, 50, "Check the second package."),
  promptTurn(4, 100, "Summarise what broke."),
];
const POISON_LIMIT_AT_MINUTE = 20;
const POISON_OUT_OF_WINDOW_MINUTE = 500;
const POISON_FAIL_ROW = 1;
const POISON_LIMIT_ROW = 2;
/**
 * The row an out-of-window limit anchors to: `resolveLimitTraceRow` takes the
 * NEAREST timed turn, which for a +500m instant is the last one. Both fixtures
 * end on a +100m turn, and both number it 4.
 */
const OUT_OF_WINDOW_ROW = 4;

describe("trouble lane order on the ordinal fallback path (ISS-8721)", () => {
  it("targets the earlier FAILURE even though the later limit plots first", () => {
    const lane = troubleLane(
      fallbackSession(FAILURE_FIRST_TURNS, FAILURE_FIRST_LIMIT_AT_MINUTE)
    );

    expect(lane).toMatchObject([
      { kind: "fail", label: FAIL_SUMMARY, tl: FAILURE_FIRST_FAIL_ROW },
      { kind: "limit", tl: FAILURE_FIRST_LIMIT_ROW },
    ]);
    expect(getDotJumpRow(lane)).toBe(FAILURE_FIRST_FAIL_ROW);
  });

  it("targets the earlier LIMIT even though the later failure plots first", () => {
    const lane = troubleLane(
      fallbackSession(LIMIT_FIRST_TURNS, LIMIT_FIRST_LIMIT_AT_MINUTE)
    );

    expect(lane).toMatchObject([
      { kind: "limit", tl: LIMIT_FIRST_LIMIT_ROW },
      { kind: "fail", label: FAIL_SUMMARY, tl: LIMIT_FIRST_FAIL_ROW },
    ]);
    expect(getDotJumpRow(lane)).toBe(LIMIT_FIRST_LIMIT_ROW);
  });

  /*
   * The production wiring, in both directions: the rail the reader actually
   * clicks, mounted over the cells the fallback path produces. The pure specs
   * above pin the resolution; deleting the ordering at the call site cannot
   * leave these green on their own.
   */
  it.each([
    {
      expectedRow: FAILURE_FIRST_FAIL_ROW,
      first: "failure",
      limitAtMinute: FAILURE_FIRST_LIMIT_AT_MINUTE,
      turns: FAILURE_FIRST_TURNS,
    },
    {
      expectedRow: LIMIT_FIRST_LIMIT_ROW,
      first: "limit",
      limitAtMinute: LIMIT_FIRST_LIMIT_AT_MINUTE,
      turns: LIMIT_FIRST_TURNS,
    },
  ])(
    "clicking the trouble dot jumps to the bucket's earliest event ($first first)",
    async ({ expectedRow, limitAtMinute, turns }) => {
      const onJump = vi.fn();
      const session = fallbackSession(turns, limitAtMinute);
      const window = resolveSessionTimelineWindow(session);
      render(
        <SessionTimelineDotRail
          buckets={createDotRailStageBuckets(BUCKET_COUNT)}
          cells={buildDotCells(
            buildActivityMarkers(session, window),
            buildLimitDotEvents(session, window),
            BUCKET_COUNT
          )}
          disabled={false}
          hoverDot={null}
          onHoverDot={vi.fn()}
          onJump={onJump}
        />
      );

      await userEvent.click(
        screen.getByRole("button", { name: "Jump to Failures & limits" })
      );

      expect(onJump).toHaveBeenCalledWith(
        expectedRow,
        true,
        TraceScrollOutcome.Unresolvable
      );
    }
  );

  /*
   * The ordering key is only common if EVERY limit-dot source carries it — one
   * source without it drops the whole lane back to plotted position. The
   * explicit-throttle source short-circuits the other three, so it is asserted
   * separately from the trio.
   */
  it("carries the ordering instant on a dot from every limit source", () => {
    const window = resolveSessionTimelineWindow(
      fallbackSession(LIMIT_FIRST_TURNS, LIMIT_FIRST_LIMIT_AT_MINUTE)
    );

    const throttleDots = buildLimitDotEvents(
      fallbackSession(LIMIT_FIRST_TURNS, LIMIT_FIRST_LIMIT_AT_MINUTE),
      window
    );
    const derivedDots = buildLimitDotEvents(
      derivedLimitSourcesSession(LIMIT_FIRST_TURNS),
      window
    );

    expect(throttleDots).toHaveLength(1);
    expect(throttleDots[0].atMs).toBe(
      SESSION_START_MS + LIMIT_FIRST_LIMIT_AT_MINUTE * MINUTE_MS
    );
    expect(derivedDots).toHaveLength(3);
    expect(derivedDots.map((dot) => dot.atMs)).toEqual([
      SESSION_START_MS + 10 * MINUTE_MS,
      SESSION_START_MS + 20 * MINUTE_MS,
      SESSION_START_MS + 30 * MINUTE_MS,
    ]);
  });

  /*
   * The key choice is scoped to ONE lane, not to the session. A limit dated past
   * the window carries no instant (below), plots at 100 and so lands in the LAST
   * bucket — it must not drag a different bucket, whose own members all carry an
   * instant, back onto the mixed-scale comparison.
   */
  it("keeps a bucket's instant order when a LATER bucket holds an instantless dot", () => {
    const session = poisonedSession();
    const window = resolveSessionTimelineWindow(session);
    const cells = buildDotCells(
      buildActivityMarkers(session, window),
      buildLimitDotEvents(session, window),
      POISON_BUCKET_COUNT
    );

    expect(cells[1].r).toMatchObject([
      { kind: "limit", tl: OUT_OF_WINDOW_ROW },
    ]);
    expect(cells[0].r).toMatchObject([
      { kind: "fail", label: FAIL_SUMMARY, tl: POISON_FAIL_ROW },
      { kind: "limit", tl: POISON_LIMIT_ROW },
    ]);
    expect(getDotJumpRow(cells[0].r)).toBe(POISON_FAIL_ROW);
  });

  /*
   * The x-fallback branch, executed on a lane that genuinely MIXES the two — a
   * fail and an in-window limit that both carry an instant, plus one dated past
   * the window that does not. The whole lane drops to plotted position.
   *
   * This is what rules out the per-comparison comparator the all-or-nothing key
   * exists to reject: `atMs ?? x` would key the instantless dot on `100` against
   * two epoch-millisecond keys, sorting it to the FRONT of the lane and making
   * the rail's click target it.
   */
  it("drops a MIXED lane to plotted position rather than comparing scales", () => {
    const session = createAgentSessionDetailFixture({
      events: [],
      markers: [],
      throttles: [
        throttleAt(FAILURE_FIRST_LIMIT_AT_MINUTE),
        throttleAt(POISON_OUT_OF_WINDOW_MINUTE),
      ],
      turnItems: FAILURE_FIRST_TURNS,
    });
    const window = resolveSessionTimelineWindow(session);

    const lane = buildDotCells(
      buildActivityMarkers(session, window),
      buildLimitDotEvents(session, window),
      BUCKET_COUNT
    )[0].r;

    // Plotted position: limit 30%, fail 50%, out-of-window limit clamped to 100%.
    expect(lane).toMatchObject([
      { kind: "limit", tl: FAILURE_FIRST_LIMIT_ROW },
      { kind: "fail", label: FAIL_SUMMARY, tl: FAILURE_FIRST_FAIL_ROW },
      { kind: "limit", tl: OUT_OF_WINDOW_ROW },
    ]);
    expect(getDotJumpRow(lane)).toBe(FAILURE_FIRST_LIMIT_ROW);
  });

  /*
   * The withheld half of `withLimitDotInstant`: a limit dated past the window
   * has no position on this timeline, so it carries no instant and the lane
   * keeps the plotted-position order it has today rather than losing the dot.
   */
  it("withholds the instant for a limit dated outside the window", () => {
    const session = fallbackSession(LIMIT_FIRST_TURNS, 400);
    const dots = buildLimitDotEvents(
      session,
      resolveSessionTimelineWindow(session)
    );

    expect(dots).toHaveLength(1);
    expect(dots[0].atMs).toBeUndefined();
    expect(dots[0].x).toBe(100);
  });
});

function troubleLane(session: AgentSessionDetail) {
  const window = resolveSessionTimelineWindow(session);
  return buildDotCells(
    buildActivityMarkers(session, window),
    buildLimitDotEvents(session, window),
    BUCKET_COUNT
  )[0].r;
}

/** A session with NO persisted markers, so `buildActivityMarkers` falls back. */
function fallbackSession(
  turnItems: TurnItem[],
  limitAtMinute: number
): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    events: [],
    markers: [],
    throttles: [throttleAt(limitAtMinute)],
    turnItems,
  });
}

/**
 * The same session, plus the one field that makes a MOUNT take the fallback
 * path: a persisted strip whose bucket states no `binStartMs`/`binEndMs`.
 *
 * `useSessionTimelineScale` projects only when `hasProducerBinBounds(buckets)`
 * holds, and `projectMarkers` overwrites every marker's `x` with the same
 * window-column function — so on the projected path both dot sources are
 * already on one scale and ISS-8721's defect cannot occur. Without this field
 * the fixture's timed turns route through `buildTimedActivityBuckets`, which
 * DOES emit bin bounds, and a mounted assertion would silently exercise the
 * projected path and pass against the unfixed code.
 *
 * A bounds-less strip is a real population rather than a contrivance: every
 * payload persisted before ISS-5999 added those fields omits them, and
 * `alignBucketRowsToTranscript` repairs only `tl0`, so they stay absent.
 */
function mountedFallbackSession(
  turnItems: TurnItem[],
  limitAtMinute: number
): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    activityBuckets: [makeTimelineBucket({ label: "0m", tl0: 0 })],
    events: [],
    markers: [],
    throttles: [throttleAt(limitAtMinute)],
    turnItems,
  });
}

/** Two throttles: one inside the window, one dated far past its end. */
function poisonedSession(): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    events: [],
    markers: [],
    throttles: [
      throttleAt(POISON_LIMIT_AT_MINUTE),
      throttleAt(POISON_OUT_OF_WINDOW_MINUTE),
    ],
    turnItems: POISON_TURNS,
  });
}

function throttleAt(atMinute: number): SessionThrottle {
  const throttleMs = SESSION_START_MS + atMinute * MINUTE_MS;
  return {
    durMin: 5,
    t0: new Date(throttleMs).toISOString(),
    t1: new Date(throttleMs + 5 * MINUTE_MS).toISOString(),
    tl: 0,
    x0: 0,
  };
}

/** One limit dot from each source the explicit-throttle path short-circuits. */
function derivedLimitSourcesSession(turnItems: TurnItem[]): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    events: [limitEvent(20)],
    markers: [],
    throttles: [],
    throttleSources: [
      {
        limitKind: "usage_limit",
        observedAt: new Date(SESSION_START_MS + 10 * MINUTE_MS).toISOString(),
        provider: "anthropic",
        sourceType: SessionTraceThrottleSourceType.UsageLimit,
      },
    ],
    turnItems: [...turnItems, limitTurn(9, 30)],
  });
}

function promptTurn(row: number, atMinute: number, text: string): TurnItem {
  const tMs = SESSION_START_MS + atMinute * MINUTE_MS;
  return {
    type: "prompt",
    _row: row,
    t: new Date(tMs).toISOString(),
    tMs,
    cum: 0,
    actor: HUMAN_ACTOR,
    text,
  };
}

function failingToolTurn(row: number, atMinute: number): TurnItem {
  const tMs = SESSION_START_MS + atMinute * MINUTE_MS;
  return {
    type: "tools",
    _row: row,
    t: new Date(tMs).toISOString(),
    tMs,
    endMs: tMs + 12_000,
    cum: 0.42,
    costDelta: 0.42,
    actor: AGENT_ACTOR,
    summary: FAIL_SUMMARY,
    items: [],
    hasFail: true,
    failN: 1,
    cats: { bash: 1 },
  };
}

function limitTurn(row: number, atMinute: number): TurnItem {
  const tMs = SESSION_START_MS + atMinute * MINUTE_MS;
  return {
    type: "event",
    _row: row,
    t: new Date(tMs).toISOString(),
    tMs,
    dot: "r",
    tag: "rate_limit",
    text: "Rate limit reached",
  };
}

function limitEvent(atMinute: number): SyncedAgentSessionEvent {
  return {
    createdAt: new Date(SESSION_START_MS + atMinute * MINUTE_MS).toISOString(),
    eventType: "usage_limit",
    externalEventId: "event-limit-1",
  };
}

/**
 * THE MOUNTED-ADAPTER REGRESSION (whitlockk review of PR #6422).
 *
 * The specs above stop one layer short of production: they call `buildDotCells`
 * on the raw builders' output, so they never cross `useSessionTimelineScale`,
 * which is what actually decides which marker arrays the rail is handed. This
 * suite drives the shared detail view both adapters mount — the web session
 * page and the desktop `SessionDetailView` render this same component with the
 * fetched session verbatim — clicks the real trouble dot, and reads back the
 * transcript row that got selected.
 *
 * WHY THE FIXTURE NEEDS A BOUNDS-LESS STRIP, stated because the earlier attempt
 * at this test failed without it and the reason is the finding. On the projected
 * path `projectMarkers` re-derives EVERY marker's `x` from its instant, so both
 * dot sources arrive commensurable and this PR's fix is a no-op there — a mount
 * on that path passes against the unfixed code and proves nothing. See
 * {@link mountedFallbackSession} for the one field that forces the fallback.
 *
 * The assertion is the selected row rather than `onJump`, because the row a
 * reader lands on is the defect ISS-8721 describes.
 */
/**
 * THE RENDERED ANCHOR each lane's first member resolves to once mounted, which
 * is not always its own `tl`.
 *
 * `findTraceScrollTarget`'s contract is "greatest `[data-row]` ≤ row", and the
 * transcript does not emit an anchor per turn — consecutive prompts collapse, so
 * this fixture renders anchors 0, 2, 2, 3. The limit-first case anchors its
 * limit (`tl` 1) to rendered row 0 for that reason.
 *
 * The pair still discriminates, which is the only thing that matters: the
 * correct target and the one the pre-fix ordering would pick resolve to
 * DIFFERENT anchors in both directions, and the assertion in each case pins
 * that they differ.
 */
const FAILURE_FIRST_MOUNTED_ANCHOR = 2;
const FAILURE_FIRST_MOUNTED_WRONG_ANCHOR = 3;
const LIMIT_FIRST_MOUNTED_ANCHOR = 0;
const LIMIT_FIRST_MOUNTED_WRONG_ANCHOR = 2;

describe("trouble-dot click target in the mounted detail view (ISS-8721)", () => {
  it.each([
    {
      expectedRow: FAILURE_FIRST_MOUNTED_ANCHOR,
      first: "failure",
      limitAtMinute: FAILURE_FIRST_LIMIT_AT_MINUTE,
      turns: FAILURE_FIRST_TURNS,
      wrongRow: FAILURE_FIRST_MOUNTED_WRONG_ANCHOR,
    },
    {
      expectedRow: LIMIT_FIRST_MOUNTED_ANCHOR,
      first: "limit",
      limitAtMinute: LIMIT_FIRST_LIMIT_AT_MINUTE,
      turns: LIMIT_FIRST_TURNS,
      wrongRow: LIMIT_FIRST_MOUNTED_WRONG_ANCHOR,
    },
  ])(
    "selects the bucket's earliest event's row, not the one that plots first ($first first)",
    async ({ expectedRow, limitAtMinute, turns, wrongRow }) => {
      const user = userEvent.setup();
      render(
        <AppCoreStoryProviders>
          <AgentSessionDetailView
            backHref="/sessions"
            isLoading={false}
            session={mountedFallbackSession(turns, limitAtMinute)}
          />
        </AppCoreStoryProviders>
      );

      await user.click(
        await screen.findByRole("button", { name: "Jump to Failures & limits" })
      );

      const flashed = document.querySelector(".st-flash");
      expect(flashed).toHaveAttribute("data-row", String(expectedRow));
      // The two rows must actually differ, or the assertion above could pass
      // under either ordering and this whole suite would be inert.
      expect(expectedRow).not.toBe(wrongRow);
    }
  );
});
