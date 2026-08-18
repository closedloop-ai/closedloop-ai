import {
  type ActivityBucket,
  type AgentSessionDetail,
  AgentSessionState,
  SessionTraceThrottleSourceType,
} from "@repo/api/src/types/agent-session";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { restoreTimeZone } from "@repo/app/shared/test-fixtures/tz-utils";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBucketKey } from "../activity-bucket-rendering";
import {
  createAgentSessionDetailFixture,
  createTurnItemsSpanning,
  emptyAgentsAgentSessionDetailFixture,
  longContentAgentSessionDetailFixture,
  nullDateAgentSessionDetailFixture,
  populatedAgentSessionDetailFixture,
  withProducerBinBounds,
} from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import {
  type AgentSessionDetailContent,
  buildSessionDetailContent,
} from "../detail-content";
import {
  COMMENT_BUTTON_NAME_RE,
  INLINE_TRACE_COMMENT_PLACEHOLDER,
  resetTraceComments,
  SHOW_COMMENTS_BUTTON_NAME,
  seedSessionTraceComment,
  selectRenderedText,
  withProviders,
} from "./agent-session-detail-view.test-helpers";
import {
  EXPECTED_CLAUDE_CODE_PROPERTY_LABELS,
  expectExactClaudeCodePropertyLabels,
} from "./property-label-contract";

const BACK_TO_SESSIONS_LINK_NAME = /back to sessions/i;
const LONG_SESSION_TITLE = /A very long shared agent session detail title/;
// FEA-4172 dropped the "Subagent | …" text prefix in favor of a leading icon,
// so the collapsed box's accessible name is now just the invocation label
// ("Review lane (review)"), not "Subagent … Review lane".
const SUBAGENT_REVIEW_LANE_BUTTON_NAME = /review lane/i;
const DUPLICATE_TOOLS_BUTTON_NAME = /Ran 2 tools/i;
/**
 * The fixture transcript's real activity extent — the span the desktop producer
 * bins over, which is deliberately NOT the overshooting `endedAt` the FEA-3586
 * cases below set.
 */
const ACTIVITY_SPAN = {
  endMs: Date.parse("2026-06-10T12:04:00.000Z"),
  startMs: Date.parse("2026-06-10T12:01:00.000Z"),
};

const JUMP_TO_ACTIVITY_BUCKET_NAME = /jump to activity bucket/i;
const JUMP_TO_FAILURES_NAME = /jump to failures & limits/i;
const PR_1634_OPEN_LINK_NAME = /1634\s*open/i;
// FEA-3635: matches the linked-FEAT pill's slug label.
const FEA_3628_LINK_NAME = /FEA-3628/;
const PRD_538_LINK_NAME = /PRD-538/;
const COPY_SESSION_ID_BUTTON_NAME = /copy session id/i;
const THROTTLED_FOR_FIVE_MINUTES_TEXT = /Throttled for 5m/;
const PERCENT_STYLE_VALUE_REGEX = /%$/;
// Pins the freshness clock 11 minutes after the fixture's `lastSyncedAt`
// (2026-06-10T12:19:00Z) so the rendered relative label is deterministic.
const SYNC_STATUS_NOW = new Date("2026-06-10T12:30:00.000Z");
const SYNC_STATUS_VALUE_TEXT = "Synced · Last synced 11 min ago";
const LONG_MODEL_NAME =
  "anthropic/claude-opus-4-1-with-extra-long-provider-and-routing-label";
const LONG_REPOSITORY_NAME =
  "closedloop-ai/repository-with-a-very-long-name-for-responsive-session-panels";
const LIMIT_EVENT_TIME = "2026-06-10T12:10:00.000Z";
const LIMIT_EVENT_ROW = 7;
const ORIGINAL_CLIPBOARD_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  globalThis.navigator,
  "clipboard"
);
// `info` alongside `success`/`error`: ISS-6006 made the Session Timeline's jump
// reporting unconditional, so a click on a bar or dot that cannot land now calls
// `toast.info` in every harness that mounts this view — an incomplete mock
// crashes the click handler instead of exercising it.
vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

afterEach(() => {
  resetTraceComments();
  vi.restoreAllMocks();
  if (ORIGINAL_CLIPBOARD_DESCRIPTOR) {
    Object.defineProperty(
      globalThis.navigator,
      "clipboard",
      ORIGINAL_CLIPBOARD_DESCRIPTOR
    );
    return;
  }
  Reflect.deleteProperty(globalThis.navigator, "clipboard");
});

describe("AgentSessionDetailView", () => {
  it("guards the FEA-1928 exact property-label contract with negative controls", () => {
    expectExactClaudeCodePropertyLabels([
      ...EXPECTED_CLAUDE_CODE_PROPERTY_LABELS,
    ]);

    expect(() =>
      expectExactClaudeCodePropertyLabels([
        ...EXPECTED_CLAUDE_CODE_PROPERTY_LABELS,
        "Source artifact",
      ])
    ).toThrow();
    expect(() =>
      expectExactClaudeCodePropertyLabels(
        EXPECTED_CLAUDE_CODE_PROPERTY_LABELS.filter((label) => label !== "Cost")
      )
    ).toThrow();
  });

  it("renders loading and not-found states from the shared body", () => {
    const { rerender } = renderDetail(
      <AgentSessionDetailView backHref="/sessions" isLoading />
    );

    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();

    rerender(
      withProviders(
        <AgentSessionDetailView backHref="/sessions" isLoading={false} />
      )
    );

    expect(screen.getByText("Session not found")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: BACK_TO_SESSIONS_LINK_NAME })
    ).toHaveAttribute("href", "/sessions");
  });

  // FEA-3984 state-machine coverage (settled-empty → not-found, first-load
  // skeleton, background-refetch keeps content, and the 404-vs-provider-error
  // split) lives in the focused colocated
  // `__tests__/agent-session-detail-states.test.tsx`, driving the extracted
  // presentational states directly rather than growing this oversized file.

  it("renders populated detail without invalid placeholder leaks", async () => {
    // FEA-4233: seed a comment so the rail opens once its discovery read settles
    // (the .fp-title "Comments" header) — an empty session now defaults to the
    // collapsed handle, and a comments-present session widens the rail into view
    // only after the count is confirmed, so the panel assertion awaits it.
    seedSessionTraceComment(populatedAgentSessionDetailFixture.id);
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    await waitFor(() =>
      expect(document.querySelector(".fp-title")).toHaveTextContent("Comments")
    );

    expect(
      screen.getByText("Desktop implementation session")
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("closedloop-ai/symphony-alpha").length
    ).toBeGreaterThan(0);
    expect(screen.getByText("Session Trace")).toBeInTheDocument();
    expect(
      document.querySelector(".sd3-tracehead .sd3-th-count")
    ).toHaveTextContent(
      `${populatedAgentSessionDetailFixture.turnItems?.length.toLocaleString()} events`
    );
    expect(screen.getByText("Session Timeline")).toBeInTheDocument();
    expect(
      document.querySelectorAll(".sd3-bar2.stacked").length
    ).toBeGreaterThan(0);
    const idleOrGapCount =
      document.querySelectorAll(".sd3-bar2.idle").length +
      document.querySelectorAll(".sd3-bar2.cb-gap").length;
    expect(idleOrGapCount).toBeGreaterThan(0);
    expect(document.querySelector(".fp-title")).toHaveTextContent("Comments");
    expect(screen.getByText("Properties")).toBeInTheDocument();
    expect(document.querySelectorAll(".sd3-props-preview")).toHaveLength(1);
    expect(document.querySelector(".sd3-statstrip")).not.toBeInTheDocument();
    expect(screen.queryByText("Phase Glance")).not.toBeInTheDocument();
    expect(bodyText()).not.toContain("Agent Analytics");
    expect(bodyText()).not.toContain("Event timeline");
    expect(bodyText()).not.toContain("Invalid Date");
    expect(bodyText()).not.toContain("undefined");
    expect(bodyText()).not.toContain("NaN");
  });

  /*
   * FEA-3428 / FEA-4287, retargeted by ISS-5999 from the collapsed Properties
   * preview to the EXPANDED `Status` row.
   *
   * ISS-5818 removed status from the collapsed strip — the title already carries
   * a chip off the SESSION_STATUS lifecycle axis, and restating
   * `AgentSessionState` 24px below it could put two legitimately-different words
   * in one viewport — and ISS-5999 retired the gate that made the removal
   * conditional. So the coloured dot and its hover title have no surviving
   * placement on this page; what survives, and is the part FEA-4287 was actually
   * about, is the LABEL each state maps to. `Error` must read "Failed" (the word
   * the Sessions LIST badge uses for the `error` status), never "Blocked".
   */
  it("FEA-4287: names each session state on the expanded Status row", () => {
    for (const [state, label] of [
      [AgentSessionState.Completed, "Completed"],
      [AgentSessionState.Blocked, "Blocked"],
      [AgentSessionState.Error, "Failed"],
    ] as const) {
      const { unmount } = renderDetail(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={createAgentSessionDetailFixture({ state })}
        />
      );

      fireEvent.click(screen.getByText("Properties"));
      const row = screen
        .getByText("Status")
        .closest(".prd-prop") as HTMLElement | null;
      expect(row, `${state} must render a Status row`).not.toBeNull();
      expect(row).toHaveTextContent(label);
      unmount();
    }
  });

  // ISS-4654: the FEA-4287 abandoned-dot test stood here. `AgentSessionState
  // .Abandoned` is retired — ISS-4586 supersedes FEA-4287's abandonment half —
  // so there is no longer a distinct Abandoned rendering to assert. The Error
  // case above still pins the other half of FEA-4287 (a terminal failure does
  // not collapse to Blocked), which is the part that survives.

  it("renders the FEA-1928 source-backed field inventory from the shared detail contract", async () => {
    const user = userEvent.setup();
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={{
          ...populatedAgentSessionDetailFixture,
        }}
      />
    );

    await user.click(screen.getByRole("button", { name: "Properties" }));

    const propertyLabels = Array.from(
      document.querySelectorAll(".prd-prop-label"),
      (label) => label.textContent ?? ""
    );
    expectExactClaudeCodePropertyLabels(propertyLabels);

    const renderedText = bodyText();
    for (const expectedText of [
      "Desktop implementation session",
      "ext-session-1",
      "closedloop-ai/symphony-alpha",
      "fea-1707",
      "$4.82",
      // ISS-5131 retired the Duration decomposition, so the row prints the ONE
      // wall measure ("20m 0s"). The fixture's `activeAgent: "18m"` sub-fact is
      // no longer rendered anywhere; its absence is pinned by
      // `session-duration-property.test.tsx`'s `RETIRED_SUB_FACT_LABELS`.
      "20m",
      "120",
      "12",
      "4",
      "8",
      "5",
      "1",
      "82",
      "12,000",
      "3,200",
      "900",
      "400",
      "rg",
      "vitest",
      "Review lane",
    ]) {
      expect(renderedText).toContain(expectedText);
    }

    for (const disallowedText of [
      "Compute target",
      "Project",
      "Worktree",
      "Base branch",
      "Source artifact",
      "Source loop",
      "Files changed",
      "Ada's MacBook",
      "Desktop MLP",
      "worktrees/symphony-alpha-fea-1707",
      "loop-1",
    ]) {
      expect(renderedText).not.toContain(disallowedText);
    }

    expect(
      document.querySelector(".sd3-tracehead .sd3-th-count")
    ).toHaveTextContent(
      `${populatedAgentSessionDetailFixture.turnItems?.length.toLocaleString()} events`
    );
    expect(bodyText()).not.toContain("Invalid Date");
    expect(bodyText()).not.toContain("undefined");
    expect(bodyText()).not.toContain("NaN");
    expect(bodyText()).not.toContain("Unknown");
  });

  it("FEA-3529: renders the transcript sync-state row when the flag is enabled", async () => {
    // Pin the clock (shouldAdvanceTime keeps userEvent's internal timers moving)
    // so the derived relative freshness is deterministic and can be asserted
    // exactly, per AGENTS.md Test Practices.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(SYNC_STATUS_NOW);
    try {
      const user = userEvent.setup();
      render(
        withProviders(
          <AgentSessionDetailView
            backHref="/sessions"
            isLoading={false}
            session={createAgentSessionDetailFixture({
              transcriptDisposition: TranscriptDisposition.Synced,
            })}
          />
        )
      );

      await user.click(screen.getByRole("button", { name: "Properties" }));

      const propertyLabels = Array.from(
        document.querySelectorAll(".prd-prop-label"),
        (label) => label.textContent ?? ""
      );
      expect(propertyLabels).toContain("Sync");
      // Disposition verdict + freshness fold into one lag-aware value; assert the
      // exact rendered text, not just a "Last synced" prefix.
      expect(screen.getByText(SYNC_STATUS_VALUE_TEXT)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  // FEA-3725: the Owner row is unconditional now (no `sessions-owner-attribution`
  // flag). These pin the previously flag-bypassed detail path — the row renders
  // with no flags enabled, showing the owner's display name or the null-owner
  // em-dash.
  it("FEA-3725: renders the Owner row with the display name and no flags enabled", async () => {
    const user = userEvent.setup();
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createAgentSessionDetailFixture({
          user: {
            id: "user-owner",
            firstName: "Grace",
            lastName: "Hopper",
            email: "grace@example.com",
            avatarUrl: null,
          },
        })}
      />
    );

    await user.click(screen.getByRole("button", { name: "Properties" }));

    const ownerRow = screen.getByText("Owner").closest(".prd-prop");
    expect(ownerRow).toHaveTextContent("OwnerGrace Hopper");
  });

  it("FEA-3725: renders the Owner row with an em-dash when the session has no owner", async () => {
    const user = userEvent.setup();
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createAgentSessionDetailFixture({ user: null })}
      />
    );

    await user.click(screen.getByRole("button", { name: "Properties" }));

    const ownerRow = screen.getByText("Owner").closest(".prd-prop");
    expect(ownerRow).toHaveTextContent("Owner—");
  });

  it("copies the external session id from the Properties panel", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    await user.click(screen.getByRole("button", { name: "Properties" }));
    await user.click(
      screen.getByRole("button", { name: COPY_SESSION_ID_BUTTON_NAME })
    );

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("ext-session-1");
      expect(toast.success).toHaveBeenCalledWith("Session ID copied");
    });
  });

  it("FEA-4186: scales an active session's timeline axis to last activity, not now or updatedAt", () => {
    /*
     * Active session (no endedAt): startedAt 12:00, lastActivity 13:00 (+1h),
     * a later sync-bumped updatedAt 21:00 (+9h), rendered at now = 22:00 (+10h).
     * The axis must scale to the observed active span (1h 0m), NOT to now
     * (10h 0m) and NOT to the fresher updatedAt (9h 0m).
     *
     * ISS-4684 changed only the LABEL's unit system here ("60m" -> "1h 0m");
     * the last-activity ANCHOR this test pins is unchanged, so the negative
     * now/updatedAt guards below are what carry the FEA-4186 contract.
     *
     * The transcript is re-timed onto that same 12:00->13:00 hour, because the
     * axis measures the rows it plots: leaving the fixture's default
     * 12:01-12:04 rows in place would make the session claim an hour of work its
     * own transcript says lasted three minutes, and the axis would report the
     * three.
     */
    const startedAt = "2026-06-10T12:00:00.000Z";
    const lastActivityAt = "2026-06-10T13:00:00.000Z";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T22:00:00.000Z"));
    try {
      renderDetail(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={createAgentSessionDetailFixture({
            startedAt: new Date(startedAt),
            lastActivityAt: new Date(lastActivityAt),
            updatedAt: new Date("2026-06-10T21:00:00.000Z"),
            endedAt: null,
            state: AgentSessionState.Running,
            status: "running",
            turnItems: createTurnItemsSpanning(startedAt, lastActivityAt),
          })}
        />
      );

      const axisScale = document.querySelector<HTMLElement>(
        ".sd3-act-axis span[title]"
      );
      expect(axisScale).toHaveTextContent("1h 0m");
      // now-anchored would render "10h 0m"; updatedAt-anchored "9h 0m".
      expect(axisScale).not.toHaveTextContent("10h");
      expect(axisScale).not.toHaveTextContent("9h");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the session timeline tracker on the first clicked bucket when a stale scroll frame is pending", async () => {
    const user = userEvent.setup();
    let staleFrame: FrameRequestCallback | null = null;
    const requestFrame = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((callback) => {
        staleFrame = callback;
        return 42;
      });
    const cancelFrame = vi
      .spyOn(globalThis, "cancelAnimationFrame")
      .mockImplementation((id) => {
        if (id === 42) {
          staleFrame = null;
        }
      });

    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    const scroller = document.querySelector<HTMLElement>(".sd3-scroll");
    if (!scroller) {
      throw new Error("Expected the shared session detail scroller");
    }
    setElementRect(scroller, { height: 400, left: 0, top: 0, width: 800 });
    for (const row of document.querySelectorAll<HTMLElement>(
      ".st [data-row]"
    )) {
      setElementRect(row, {
        height: 24,
        left: 0,
        top: row.dataset.row === "0" ? 0 : 1000,
        width: 800,
      });
    }

    fireEvent.scroll(scroller);
    expect(requestFrame).toHaveBeenCalled();

    // The LAST jumpable column, not a fixed index: ISS-5819's clock window
    // decides how many of the 24 columns carry a jump target at all, and this
    // test is about the stale frame being cancelled — not about which column was
    // hit.
    const jumpableBars = screen.getAllByRole("button", {
      name: JUMP_TO_ACTIVITY_BUCKET_NAME,
    });
    await user.click(jumpableBars.at(-1) as HTMLElement);

    const clickedLeft = getSessionTimelineTrackerLeft();
    expect(clickedLeft).toMatch(PERCENT_STYLE_VALUE_REGEX);
    expect(cancelFrame).toHaveBeenCalledWith(42);

    const requestFrameCallsAfterClick = requestFrame.mock.calls.length;
    fireEvent.scroll(scroller);
    expect(requestFrame).toHaveBeenCalledTimes(requestFrameCallsAfterClick);

    if (staleFrame) {
      act(() => staleFrame?.(0));
    }

    expect(getSessionTimelineTrackerLeft()).toBe(clickedLeft);
  });

  it("keeps recalculating active rows after a click whose programmatic scroll is clamped", async () => {
    const user = userEvent.setup();
    const requestFrame = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation(() => 42);
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {
      // Test-only requestAnimationFrame shim.
    });

    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    const scroller = document.querySelector<HTMLElement>(".sd3-scroll");
    if (!scroller) {
      throw new Error("Expected the shared session detail scroller");
    }
    setElementRect(scroller, { height: 400, left: 0, top: 0, width: 800 });
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => 0,
      set: () => {
        // Simulate the browser clamping a requested scroll past a boundary.
      },
    });
    for (const row of document.querySelectorAll<HTMLElement>(
      ".st [data-row]"
    )) {
      setElementRect(row, {
        height: 24,
        left: 0,
        top: row.dataset.row === "0" ? 0 : 1000,
        width: 800,
      });
    }

    await user.click(
      screen.getAllByRole("button", {
        name: JUMP_TO_ACTIVITY_BUCKET_NAME,
      })[2]
    );

    requestFrame.mockClear();
    fireEvent.scroll(scroller);
    expect(requestFrame).toHaveBeenCalledTimes(1);
  });

  it("re-keys persisted activity buckets so a bar click jumps to the transcript row in its time slice (FEA-3412)", async () => {
    const user = userEvent.setup();
    // Persisted buckets arrive from desktop sync with `tl0` in timeline-event
    // index space, not transcript `_row` space (see `alignBucketRowsToTranscript`).
    // Seed pointers that overshoot every rendered row so, unrepaired, each bar
    // would flash the last row (greatest `data-row` ≤ tl0) rather than its slice.
    // `endedAt` (12:06) sits just past the last real transcript row (12:04), so
    // the repair buckets over the REAL activity span [12:01, 12:04] — matching
    // the desktop producer (FEA-3586) — giving three 1-minute slices.
    const session = createAgentSessionDetailFixture({
      endedAt: new Date("2026-06-10T12:06:00.000Z"),
      // ISS-5819 review (wongk): binned over the REAL activity span, as the
      // desktop producer bins them — the overshooting `endedAt` above is exactly
      // the window the producer does NOT use, and the projection now takes the
      // bins' own bounds rather than borrowing this page's axis window.
      activityBuckets: withProducerBinBounds(
        [
          makeActivityBucket({ label: "0m", tl0: 40 }),
          makeActivityBucket({ label: "1m", tl0: 41 }),
          makeActivityBucket({ label: "2m", tl0: 42 }),
        ],
        ACTIVITY_SPAN
      ),
    });

    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={session}
      />
    );

    /*
     * ISS-5999: the strip now always projects onto the ISS-5819 clock window,
     * whose finest scale is 5 MINUTES — so this 3-minute run's three 1-minute
     * source bins share one rendered column, and the per-slice arithmetic is no
     * longer observable here. It did not stop being covered: the slice mapping
     * moved to `alignBucketRowsToTranscript`'s own suite
     * (`agents/lib/__tests__/session-timeline-geometry.test.ts`), which is where
     * the repair lives. What this test still owns is the WIRING — that the view
     * feeds the repaired rows to the bar's `onJump` at all.
     */
    const bars = screen.getAllByRole("button", {
      name: JUMP_TO_ACTIVITY_BUCKET_NAME,
    });
    expect(bars).toHaveLength(1);

    // A real, in-range transcript row — never the last-row flash the stale
    // sync-time `tl0` (40/41/42) would produce unrepaired.
    await user.click(bars[0]);
    expect(document.querySelector(".st-flash")).toHaveAttribute(
      "data-row",
      "0"
    );
  });

  it("still re-keys persisted buckets for a zero-duration session so bar clicks work (FEA-3412)", async () => {
    const user = userEvent.setup();
    /*
     * A persisted desktop session that begins and ends on one instant — every
     * transcript row included, since the timeline is bucketed over the rows it
     * plots — is a valid, clickable session on the producer side:
     * `buildTraceActivityFields` rejects only `endMs < startMs` and floors the
     * span at 1ms via `Math.max(1, endMs - startMs)`. The client repair must
     * mirror that instead of bailing on equality — otherwise these buckets keep
     * their raw timeline-index `tl0` (40/41/42, which overshoot every rendered
     * row) and, unrepaired, each bar would flash the LAST transcript row
     * (greatest `data-row` ≤ tl0). Seed the same overshooting pointers and
     * assert each bar now lands on a real, in-range transcript row instead.
     */
    const instantIso = "2026-06-10T12:01:00.000Z";
    const instant = new Date(instantIso);
    const session = createAgentSessionDetailFixture({
      startedAt: instant,
      updatedAt: instant,
      lastActivityAt: instant,
      endedAt: instant,
      turnItems: createTurnItemsSpanning(instantIso, instantIso),
      activityBuckets: withProducerBinBounds(
        [
          makeActivityBucket({ label: "0m", tl0: 40 }),
          makeActivityBucket({ label: "2m", tl0: 41 }),
          makeActivityBucket({ label: "4m", tl0: 42 }),
        ],
        // The producer floors a zero-length run's span at 1ms rather than
        // rejecting it; so does this stamp.
        { endMs: instant.getTime(), startMs: instant.getTime() }
      ),
    });

    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={session}
      />
    );

    // ISS-5999: one rendered column at the window's 5-minute floor (see the
    // note on the test above). Over the floored 1ms span every timed row falls
    // in the opening slice, so the bar jumps to the earliest transcript row
    // (_row 0) — a real rendered row, never the last-row flash the stale tl0
    // (40/41/42) would cause.
    const bars = screen.getAllByRole("button", {
      name: JUMP_TO_ACTIVITY_BUCKET_NAME,
    });
    expect(bars).toHaveLength(1);

    await user.click(bars[0]);
    expect(document.querySelector(".st-flash")).toHaveAttribute(
      "data-row",
      "0"
    );
  });

  it("buckets transcript rows over the real activity window when ended_at overshoots, so bars past the first slice anchor correctly (FEA-3586)", async () => {
    const user = userEvent.setup();
    // The reporter saw "no bars past the first hour" and a green dot that did
    // not anchor to its time block. Root cause: a stale/overshooting end anchor
    // (here `endedAt` set 40m past the last real transcript row at 12:04)
    // stretched the bucket window so every timed row collapsed into the opening
    // slice — so bars past the first all forward-filled to the top-of-transcript
    // row. The repair must bucket rows over the REAL activity span
    // [12:01, 12:04], matching the desktop producer, so later bars anchor to
    // their own slice.
    const session = createAgentSessionDetailFixture({
      endedAt: new Date("2026-06-10T12:44:00.000Z"),
      // ISS-5819 review (wongk): binned over the REAL activity span, as the
      // desktop producer bins them — the overshooting `endedAt` above is exactly
      // the window the producer does NOT use, and the projection now takes the
      // bins' own bounds rather than borrowing this page's axis window.
      activityBuckets: withProducerBinBounds(
        [
          makeActivityBucket({ label: "0m", tl0: 40 }),
          makeActivityBucket({ label: "1m", tl0: 41 }),
          makeActivityBucket({ label: "2m", tl0: 42 }),
        ],
        ACTIVITY_SPAN
      ),
    });

    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={session}
      />
    );

    /*
     * ISS-5999: the overshooting-window arithmetic — that the middle and
     * trailing slices anchor to _row 3 and _row 4 rather than collapsing to the
     * top of the transcript — moved to `alignBucketRowsToTranscript`'s own suite
     * when the 5-minute window floor merged these three bins into one column.
     * The wiring assertion stays here.
     */
    const bars = screen.getAllByRole("button", {
      name: JUMP_TO_ACTIVITY_BUCKET_NAME,
    });
    expect(bars).toHaveLength(1);

    await user.click(bars[0]);
    expect(document.querySelector(".st-flash")).toHaveAttribute(
      "data-row",
      "0"
    );
  });

  it("renders fallback limit evidence as one red timeline dot when persisted markers exist", async () => {
    const user = userEvent.setup();
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createLimitDotSession()}
      />
    );

    expect(document.querySelector(".sd3-dot.d-b")).toBeInTheDocument();
    expect(document.querySelector(".sd3-dot.d-g")).toBeInTheDocument();
    const redDot = getOnlyRedTimelineDot();

    await user.hover(redDot);
    expect(await screen.findByText("Failures & limits")).toBeInTheDocument();
    // FEA-3642: the surviving dot is derived from the structured `usage_limit`
    // event type (formatted "Usage Limit"), not the removed free-text timeline
    // title scan. The indicator still appears at the recorded position.
    expect(screen.getByText("Usage Limit")).toBeInTheDocument();

    await user.click(redDot);
    expect(document.querySelector(".st-flash")).toHaveAttribute(
      "data-row",
      String(LIMIT_EVENT_ROW)
    );
  });

  // FEA-3413: clicking any activity-timeline dot must scroll the transcript to
  // that dot's first event and flash it — not silently jump to the top.
  it("scrolls the transcript to a commit/PR dot's first event and flashes it", async () => {
    const user = userEvent.setup();
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createLimitDotSession()}
      />
    );

    // The sole green marker in createLimitDotSession() is the checkpoint commit
    // at trace row 8 (see its `markers`).
    await user.click(getOnlyTimelineDot("g"));
    expect(document.querySelector(".st-flash")).toHaveAttribute(
      "data-row",
      "8"
    );
  });

  it("flashes a human-steering dot's first event on click", async () => {
    const user = userEvent.setup();
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createLimitDotSession()}
      />
    );

    // The sole blue marker is the initial prompt at trace row 0.
    await user.click(getOnlyTimelineDot("b"));
    expect(document.querySelector(".st-flash")).toHaveAttribute(
      "data-row",
      "0"
    );
  });

  it("does not jump to the top when a dot's first event has no trace row", async () => {
    const user = userEvent.setup();
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createLimitDotSession({
          // A synced/deserialized marker can arrive without `tl` despite the
          // `number` type; the dot must be an inert no-op, never a silent `?? 0`
          // jump to the top of the transcript.
          markers: [
            {
              kind: "commit",
              label: "Checkpoint commit",
              t: "12:16:00",
              tl: undefined as unknown as number,
              x: 80,
            },
          ],
        })}
      />
    );

    await user.click(getOnlyTimelineDot("g"));
    expect(document.querySelector(".st-flash")).toBeNull();
  });

  it("does not crash when limit evidence exists without activity buckets", () => {
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createLimitDotSession({
          activityBuckets: [],
          events: [
            {
              agentExternalId: "agent-main",
              createdAt: LIMIT_EVENT_TIME,
              eventType: SessionTraceThrottleSourceType.UsageLimit,
              externalEventId: "bucketless-limit-event",
              summary: "Usage limit reached.",
            },
          ],
          markers: [],
          timeline: [],
          turnItems: [],
        })}
      />
    );

    expect(
      screen.getByText("No activity recorded for this session.")
    ).toBeInTheDocument();
  });

  it("renders throttle source fallback when throttles are empty", async () => {
    const user = userEvent.setup();
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createLimitDotSession({
          events: [],
          throttleSources: [
            {
              errorCode: null,
              limitKind: "session_limit",
              observedAt: LIMIT_EVENT_TIME,
              provider: "Codex",
              resetAt: "2026-06-10T12:15:00.000Z",
              retryAfterSeconds: 300,
              sourceType: SessionTraceThrottleSourceType.UsageLimit,
              statusCode: 429,
            },
          ],
          timeline: [],
        })}
      />
    );

    const redDot = getOnlyRedTimelineDot();
    await user.hover(redDot);
    expect(
      await screen.findByText("Session Limit (Codex, HTTP 429)")
    ).toBeInTheDocument();

    await user.click(redDot);
    expect(document.querySelector(".st-flash")).toHaveAttribute(
      "data-row",
      String(LIMIT_EVENT_ROW)
    );
  });

  it("keeps explicit throttles authoritative and jumps them to the nearest trace row", async () => {
    const user = userEvent.setup();
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createLimitDotSession({
          throttles: [
            {
              durMin: 5,
              t0: LIMIT_EVENT_TIME,
              t1: "2026-06-10T12:15:00.000Z",
              tl: 0,
              x0: 50,
            },
          ],
        })}
      />
    );

    const redDot = getOnlyRedTimelineDot();
    await user.hover(redDot);
    expect(
      await screen.findByText(THROTTLED_FOR_FIVE_MINUTES_TEXT)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(SessionTraceThrottleSourceType.UsageLimit)
    ).not.toBeInTheDocument();

    await user.click(redDot);
    expect(document.querySelector(".st-flash")).toHaveAttribute(
      "data-row",
      String(LIMIT_EVENT_ROW)
    );
  });

  it("renders a turn-item limit event once when persisted markers are absent", async () => {
    const user = userEvent.setup();
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createLimitDotSession({
          events: [],
          markers: [],
          timeline: [],
        })}
      />
    );

    const redDot = getOnlyRedTimelineDot();
    await user.hover(redDot);
    expect(
      await screen.findByText(SessionTraceThrottleSourceType.UsageLimit)
    ).toBeInTheDocument();
    expect(screen.queryByText("2 events")).not.toBeInTheDocument();
  });

  it("does not render a limit dot for ordinary trace prose that mentions rate limits", () => {
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createLimitDotSession({
          events: [],
          timeline: [],
          turnItems: createRateLimitProseTurnItems(),
        })}
      />
    );

    expect(document.querySelectorAll(".sd3-drail .sd3-dot.d-r")).toHaveLength(
      0
    );
  });

  it("does not render a limit dot when 429 is part of another identifier", () => {
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createLimitDotSession({
          events: [
            {
              agentExternalId: "agent-main",
              createdAt: LIMIT_EVENT_TIME,
              eventType: "comment",
              externalEventId: "unrelated-identifier-event",
              summary: "Reviewed PR #1429 before continuing.",
            },
          ],
          timeline: [],
          turnItems: createNeutralLimitTargetTurnItems(),
        })}
      />
    );

    expect(document.querySelectorAll(".sd3-drail .sd3-dot.d-r")).toHaveLength(
      0
    );
  });

  // FEA-3642: a non-limit event whose free-text `summary` merely mentions a rate
  // limit (e.g. GitHub's "secondary rate limit" message, or the agent discussing
  // 429s) must NOT be misclassified as a real limit. The event type is structured
  // ("tool_result"), and only structured signals drive the indicator.
  it("does not render a limit dot when only an event summary mentions a rate limit", () => {
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createLimitDotSession({
          events: [
            {
              agentExternalId: "agent-main",
              createdAt: LIMIT_EVENT_TIME,
              eventType: "tool_result",
              externalEventId: "github-secondary-rate-limit-event",
              summary:
                "GitHub API returned a secondary rate limit; retried the call.",
            },
          ],
          timeline: [],
          turnItems: createNeutralLimitTargetTurnItems(),
        })}
      />
    );

    expect(document.querySelectorAll(".sd3-drail .sd3-dot.d-r")).toHaveLength(
      0
    );
  });

  // FEA-3642: a red-dot turn item is not inherently a limit — `dot: "r"` also
  // marks failures. A failed tool turn whose text discusses throttling/429 must
  // not surface a limit indicator when its structured `tag` is not a limit type.
  it("does not render a limit dot for a failure turn item that discusses throttling", () => {
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createLimitDotSession({
          events: [],
          timeline: [],
          turnItems: createThrottleMentionFailureTurnItems(),
        })}
      />
    );

    expect(document.querySelectorAll(".sd3-drail .sd3-dot.d-r")).toHaveLength(
      0
    );
  });

  // FEA-3642: a free-text timeline title/detail that mentions rate limiting is no
  // longer scanned at all — the timeline carries no structured limit signal.
  it("does not render a limit dot for a timeline event whose title mentions rate limits", () => {
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createLimitDotSession({
          events: [],
          timeline: [
            {
              detail: "Provider responded 429; will slow down.",
              kind: "result",
              t: LIMIT_EVENT_TIME,
              tMs: Date.parse(LIMIT_EVENT_TIME),
              title: "Discussed the rate limit in the tool output",
              tl: LIMIT_EVENT_ROW,
            },
          ],
          turnItems: createNeutralLimitTargetTurnItems(),
        })}
      />
    );

    expect(document.querySelectorAll(".sd3-drail .sd3-dot.d-r")).toHaveLength(
      0
    );
  });

  // FEA-3642: the authoritative structured signal still fires. A recorded
  // `session.throttles` entry shows the indicator at the right position even when
  // no free-text mention exists anywhere in the transcript.
  it("renders a limit dot from a recorded throttle even when the transcript never mentions limits", async () => {
    const user = userEvent.setup();
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createLimitDotSession({
          events: [],
          throttles: [
            {
              durMin: 5,
              t0: LIMIT_EVENT_TIME,
              t1: "2026-06-10T12:15:00.000Z",
              tl: 0,
              x0: 50,
            },
          ],
          timeline: [],
          turnItems: createNeutralLimitTargetTurnItems(),
        })}
      />
    );

    const redDot = getOnlyRedTimelineDot();
    await user.hover(redDot);
    expect(
      await screen.findByText(THROTTLED_FOR_FIVE_MINUTES_TEXT)
    ).toBeInTheDocument();

    await user.click(redDot);
    expect(document.querySelector(".st-flash")).toHaveAttribute(
      "data-row",
      String(LIMIT_EVENT_ROW)
    );
  });

  // FEA-3642: the limit dot is now anchored on the structured turn-item `tag`
  // (`usage_limit`) rather than a free-text timeline title. With two trace rows
  // sharing the same timestamp, the dot still resolves to the limit row's own
  // explicit `_row`, not the neutral adjacent row.
  it("resolves a structured limit turn item to its own row when timestamps collide", async () => {
    const user = userEvent.setup();
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createLimitDotSession({
          events: [],
          timeline: [],
          turnItems: createSameTimestampLimitTurnItems(),
        })}
      />
    );

    await user.click(getOnlyRedTimelineDot());
    expect(document.querySelector(".st-flash")).toHaveAttribute(
      "data-row",
      String(LIMIT_EVENT_ROW)
    );
  });

  it("uses the matched limit signal when fallback event summaries are generic", async () => {
    const user = userEvent.setup();
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createLimitDotSession({
          events: [
            {
              agentExternalId: "agent-main",
              createdAt: LIMIT_EVENT_TIME,
              data: { statusCode: 429 },
              eventType: SessionTraceThrottleSourceType.ApiError,
              externalEventId: "generic-limit-event",
              summary: "Request failed.",
            },
          ],
          timeline: [],
          turnItems: createNeutralLimitTargetTurnItems(),
        })}
      />
    );

    const redDot = getOnlyRedTimelineDot();
    await user.hover(redDot);
    expect(await screen.findByText("HTTP 429")).toBeInTheDocument();
  });

  it("keeps the trace gutter separate without active row background fill", () => {
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    const firstMessageRow = document.querySelector<HTMLElement>(".st-msg");
    const firstCost = document.querySelector(".st-gut-line.cost");

    expect(firstMessageRow).toBeInTheDocument();
    expect(firstMessageRow?.className).not.toContain("bg-primary");
    expect(firstCost).toHaveTextContent("$1.29");
  });

  it("supports trace playhead, comments, tools, and subagent expansion", async () => {
    const user = userEvent.setup();
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    expect(
      screen.getByText("Please inspect the shared session detail screen.")
    ).toBeInTheDocument();
    expect(screen.getByText("Ran 2 tools")).toBeInTheDocument();
    expect(screen.getByText("1 failed")).toBeInTheDocument();
    expect(screen.getAllByText("rg").length).toBeGreaterThan(0);
    expect(screen.getAllByText("vitest").length).toBeGreaterThan(0);
    expect(
      screen.queryByText("Verify import ownership and state coverage.")
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: SUBAGENT_REVIEW_LANE_BUTTON_NAME })
    );
    expect(
      screen.getByText("Verify import ownership and state coverage.")
    ).toBeInTheDocument();

    await user.click(
      screen.getAllByRole("button", {
        name: JUMP_TO_ACTIVITY_BUCKET_NAME,
      })[2]
    );
    await user.click(
      screen.getAllByRole("button", {
        name: JUMP_TO_FAILURES_NAME,
      })[0]
    );
    selectRenderedText(document.body, "shared session detail screen");
    fireEvent.mouseUp(document.querySelector(".st") as HTMLElement);
    await user.click(
      screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    );
    await user.type(
      screen.getByPlaceholderText(INLINE_TRACE_COMMENT_PLACEHOLDER),
      "@ai summarize the failed tool"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));
    expect(screen.getAllByText("shared session detail screen")).toHaveLength(2);
    expect(
      screen.getByText("@ai summarize the failed tool")
    ).toBeInTheDocument();

    selectRenderedText(document.body, "Please inspect");
    fireEvent.mouseUp(document.querySelector(".st") as HTMLElement);
    await user.click(
      screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    );
    await user.type(
      screen.getByPlaceholderText(INLINE_TRACE_COMMENT_PLACEHOLDER),
      "Second local note"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));
    expect(screen.getByText("Second local note")).toBeInTheDocument();

    document.querySelector(".st-flash")?.classList.remove("st-flash");
    await user.click(screen.getByText("@ai summarize the failed tool"));
    expect(document.querySelector(".st-flash")).toHaveAttribute(
      "data-row",
      "0"
    );
    expect(
      document.querySelector("[data-trace-selected-passage]")?.textContent
    ).toBe("shared session detail screen");
  });

  it("keeps repeated tool calls keyed uniquely when expanded", async () => {
    const user = userEvent.setup();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const sessionWithDuplicateTools = createAgentSessionDetailFixture({
      turnItems: populatedAgentSessionDetailFixture.turnItems?.map((item) =>
        item.type === "tools"
          ? {
              ...item,
              defaultOpen: false,
              failN: 0,
              hasFail: false,
              items: [
                { detail: "", err: false, label: "exec_command" },
                { detail: "", err: false, label: "exec_command" },
              ],
              summary: "Ran 2 tools",
            }
          : item
      ),
    });

    try {
      renderDetail(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={sessionWithDuplicateTools}
        />
      );

      await user.click(
        screen.getByRole("button", { name: DUPLICATE_TOOLS_BUTTON_NAME })
      );

      expect(screen.getAllByText("exec_command")).toHaveLength(2);
      expect(
        consoleErrorSpy.mock.calls.filter(([message]) =>
          String(message).includes("same key")
        )
      ).toHaveLength(0);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("keeps the FEA-1770 comments resize handle non-focusable and source-shaped", async () => {
    // FEA-4233: seed a comment so the open rail (and its resize handle) renders
    // once the discovery read settles; an empty session now defaults to the
    // collapsed handle, and a comments-present rail widens into view only after
    // the count is confirmed.
    seedSessionTraceComment(populatedAgentSessionDetailFixture.id);
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    await waitFor(() =>
      expect(document.querySelector(".fp-resize")).toBeInTheDocument()
    );

    // The draggable timeline scrubber was removed (clicking the graph jumps the
    // trace), so only the comments rail resize handle remains as a mouse-only,
    // non-focusable drag affordance.
    expect(document.querySelector(".sd3-playhead")).toBeNull();
    const resizeHandle = document.querySelector<HTMLElement>(".fp-resize");
    expect(resizeHandle?.tagName).toBe("DIV");
    expect(resizeHandle?.tabIndex).toBe(-1);
    expect(resizeHandle).not.toHaveAttribute("role");
  });

  it("can hide the comments rail when the route header toggles it closed", () => {
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        commentsRailOpen={false}
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    expect(document.querySelector(".sd3-cmts")).not.toBeInTheDocument();
    expect(screen.getByText("Session Trace")).toBeInTheDocument();
  });

  it("preserves persisted trace comments when the route header hides and reopens the rail", async () => {
    const user = userEvent.setup();
    const { rerender } = renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        commentsRailOpen
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    selectRenderedText(document.body, "shared session detail screen");
    fireEvent.mouseUp(document.querySelector(".st") as HTMLElement);
    await user.click(
      screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    );
    await user.type(
      screen.getByPlaceholderText(INLINE_TRACE_COMMENT_PLACEHOLDER),
      "Keep this comment"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(screen.getByText("Keep this comment")).toBeInTheDocument();

    rerender(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          commentsRailOpen={false}
          isLoading={false}
          session={populatedAgentSessionDetailFixture}
        />
      )
    );
    expect(document.querySelector(".sd3-cmts")).not.toBeInTheDocument();

    rerender(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          commentsRailOpen
          isLoading={false}
          session={populatedAgentSessionDetailFixture}
        />
      )
    );

    expect(screen.getByText("Keep this comment")).toBeInTheDocument();
  });

  it("shows the new session's persisted trace comments when the mounted detail changes sessions", async () => {
    const user = userEvent.setup();
    const firstSession = createAgentSessionDetailFixture({
      id: "session-one",
      externalSessionId: "session-one",
      name: "Session One",
    });
    const secondSession = createAgentSessionDetailFixture({
      id: "session-two",
      externalSessionId: "session-two",
      name: "Session Two",
      turnItems: [
        {
          type: "say",
          _row: 0,
          t: "2026-06-10T12:30:00.000Z",
          tMs: Date.parse("2026-06-10T12:30:00.000Z"),
          cum: 0,
          actor: {
            color: "var(--primary)",
            harness: "codex",
            human: null,
            name: "gpt-5.5",
            sessionId: "session-two",
          },
          text: "Second session trace row.",
        },
      ],
    });
    const { rerender } = renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={firstSession}
      />
    );

    selectRenderedText(document.body, "shared session detail screen");
    fireEvent.mouseUp(document.querySelector(".st") as HTMLElement);
    await user.click(
      screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    );
    await user.type(
      screen.getByPlaceholderText(INLINE_TRACE_COMMENT_PLACEHOLDER),
      "First session note"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));
    expect(screen.getByText("First session note")).toBeInTheDocument();

    rerender(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={secondSession}
        />
      )
    );

    expect(screen.getByText("Second session trace row.")).toBeInTheDocument();
    // FEA-4233: the second session has zero trace comments, so once its comments
    // read settles empty the rail collapses to the slim handle rather than an
    // open panel reading "No trace comments yet". The first session's note is
    // gone regardless of collapse.
    await waitFor(() => {
      expect(screen.queryByText("First session note")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: SHOW_COMMENTS_BUTTON_NAME })
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("No trace comments yet")).not.toBeInTheDocument();
  });

  // FEA-3929: the web session-detail surface must wire `onReply`
  // (`replyToTraceComment`) through to the rail so the Reply affordance renders
  // and opens the inline composer. (jsdom does not apply styles.css, so the
  // hover-reveal CSS fix is verified in a real browser by
  // e2e/session-detail.spec.ts; this test guards the onReply wiring only.)
  it("exposes an operable reply affordance on a persisted trace comment", async () => {
    const user = userEvent.setup();
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        commentsRailOpen
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    selectRenderedText(document.body, "shared session detail screen");
    fireEvent.mouseUp(document.querySelector(".st") as HTMLElement);
    await user.click(
      screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    );
    await user.type(
      screen.getByPlaceholderText(INLINE_TRACE_COMMENT_PLACEHOLDER),
      "A note to reply to"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));
    expect(screen.getByText("A note to reply to")).toBeInTheDocument();

    // The Reply control is present and opens the inline reply composer,
    // proving the web adapter did not drop `onReply`.
    const replyButton = screen.getByRole("button", {
      name: "Reply to trace note",
    });
    await user.click(replyButton);
    expect(
      screen.getByRole("textbox", { name: "Reply..." })
    ).toBeInTheDocument();
  });

  it("links pull request pills to GitHub instead of a missing app route", async () => {
    const user = userEvent.setup();
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createAgentSessionDetailFixture({
          prs: [{ num: 1634, status: "open", title: "Session Trace PR" }],
        })}
      />
    );

    await user.click(screen.getByRole("button", { name: "Properties" }));

    const prLink = screen.getByRole("link", { name: PR_1634_OPEN_LINK_NAME });
    expect(prLink).toHaveAttribute(
      "href",
      "https://github.com/closedloop-ai/symphony-alpha/pull/1634"
    );
    expect(prLink).not.toHaveAttribute("href", "/pulls/1634");
    expect(prLink).toHaveAttribute("target", "_blank");

    // Styling-hook contract: the PR pill, its status, the lines-changed diff,
    // and the wrapping value cell carry the classes the properties-pane CSS
    // styles. Without them the row renders as run-together/overlapping text.
    expect(prLink).toHaveClass("sd3-result-pr");
    expect(prLink.closest(".prd-prop-value")).toHaveClass("sd3-prs-value");
    expect(prLink.querySelector(".sd3-result-status")).toHaveTextContent(
      "open"
    );
    const diff = document.querySelector(".sd3-out-diff");
    expect(diff?.querySelector(".add")).toBeInTheDocument();
    expect(diff?.querySelector(".del")).toBeInTheDocument();
  });

  // FEA-3635: a session whose transcript referenced/created a FEAT surfaces a
  // clickable "Linked features" pill on the detail Properties panel, pointing at
  // the FEAT via the shell-supplied href — parallel to the PR pills.
  it("surfaces a clickable linked-FEAT pill from linkedArtifacts", async () => {
    const user = userEvent.setup();
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        buildArtifactHref={(artifact) =>
          artifact.slug ? `/acme/features/${artifact.slug}` : null
        }
        isLoading={false}
        session={createAgentSessionDetailFixture({
          linkedArtifacts: [
            {
              id: "feat-1",
              slug: "FEA-3628",
              name: "Pack-scanner worker",
              documentType: "FEATURE",
              role: "input",
            },
          ],
        })}
      />
    );

    await user.click(screen.getByRole("button", { name: "Properties" }));

    expect(screen.getByText("Linked artifacts")).toBeInTheDocument();
    const featLink = screen.getByRole("link", { name: FEA_3628_LINK_NAME });
    expect(featLink).toHaveAttribute("href", "/acme/features/FEA-3628");
    // ISS-4793: the pill names its own kind through the DS Tooltip, not a native
    // `title` (content asserted in session-linked-artifacts-row.test.tsx).
    expect(featLink).not.toHaveAttribute("title");
    // Shares the PR-pill styling hook so the row lays out consistently.
    expect(featLink).toHaveClass("sd3-result-pr");
    expect(featLink.closest(".prd-prop-value")).toHaveClass("sd3-prs-value");
  });

  // FEA-3635: the "Linked artifacts" row is type-agnostic — a linked PRD routes
  // to /prds/<slug> and its pill title names it a "PRD" (not a "feature"), so a
  // non-FEATURE link is never mislabeled by the shared row.
  it("labels a linked PRD by its own type and routes it to /prds", async () => {
    const user = userEvent.setup();
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        buildArtifactHref={(artifact) =>
          artifact.slug && artifact.documentType === "PRD"
            ? `/acme/prds/${artifact.slug}`
            : null
        }
        isLoading={false}
        session={createAgentSessionDetailFixture({
          linkedArtifacts: [
            {
              id: "prd-1",
              slug: "PRD-538",
              name: "Usage insights",
              documentType: "PRD",
              role: "referenced",
            },
          ],
        })}
      />
    );

    await user.click(screen.getByRole("button", { name: "Properties" }));

    expect(screen.getByText("Linked artifacts")).toBeInTheDocument();
    const prdLink = screen.getByRole("link", { name: PRD_538_LINK_NAME });
    expect(prdLink).toHaveAttribute("href", "/acme/prds/PRD-538");
    expect(prdLink).not.toHaveAttribute("title");
  });

  // FEA-3635: without a shell-supplied href (e.g. desktop), the FEAT still
  // surfaces as a non-clickable label rather than a broken link.
  it("renders the linked-FEAT pill as a non-link label when no href builder is supplied", async () => {
    const user = userEvent.setup();
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createAgentSessionDetailFixture({
          linkedArtifacts: [
            {
              id: "feat-1",
              slug: "FEA-3628",
              name: "Pack-scanner worker",
              documentType: "FEATURE",
              role: "referenced",
            },
          ],
        })}
      />
    );

    await user.click(screen.getByRole("button", { name: "Properties" }));

    expect(screen.getByText("Linked artifacts")).toBeInTheDocument();
    expect(screen.getByText("FEA-3628")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: FEA_3628_LINK_NAME })
    ).not.toBeInTheDocument();
  });

  // FEA-3635: a session that referenced no artifact shows no "Linked artifacts"
  // row (nothing extra on the panel).
  // ISS-4449: integration smoke — the extracted SessionLinkedArtifactsRow wires
  // into the Properties pane and applies its client-side cap + "+N" overflow.
  // Exhaustive cap/overflow/tooltip/empty coverage lives in the component's own
  // sibling suite (session-linked-artifacts-row.test.tsx).
  it("renders the Linked artifacts row with a capped +N overflow in the Properties pane", async () => {
    const user = userEvent.setup();
    const served = Array.from({ length: 9 }, (_unused, index) => ({
      id: `doc-${index}`,
      slug: `DOC-${index}`,
      name: `Doc ${index}`,
      documentType: "DOC" as const,
      role: "referenced",
    }));
    const { container } = renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createAgentSessionDetailFixture({
          linkedArtifacts: served,
          linkedArtifactsTotal: served.length,
        })}
      />
    );

    await user.click(screen.getByRole("button", { name: "Properties" }));

    expect(screen.getByText("Linked artifacts")).toBeInTheDocument();
    // 9 links, visible cap 6 -> 6 pills + a "+3" overflow chip.
    expect(container.querySelector(".sd3-linked-overflow")?.textContent).toBe(
      "+3"
    );
  });

  it("counts opened-but-unmerged PRs in the Properties header (FEA-3329)", () => {
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createAgentSessionDetailFixture({
          // 7 PRs opened, none merged: `prsMerged` is a legitimate 0, so the old
          // `prsMerged ?? prs.length` chain never fell through and the header
          // collapsed to "0 PRs merged".
          prs: Array.from({ length: 7 }, (_unused, index) => ({
            num: 1600 + index,
            status: "open",
            title: `Opened PR ${index}`,
          })),
          prsMerged: 0,
        })}
      />
    );

    const preview = document.querySelector(".sd3-props-preview");
    expect(preview).toHaveTextContent("7 PRs");
    expect(preview).not.toHaveTextContent("0 PRs merged");
  });

  it("singularizes the Properties header PR count (FEA-3329)", () => {
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createAgentSessionDetailFixture({
          prs: [{ num: 1634, status: "merged", title: "Only PR" }],
          prsMerged: 1,
        })}
      />
    );

    const preview = document.querySelector(".sd3-props-preview");
    expect(preview).toHaveTextContent("1 PR");
    expect(preview).not.toHaveTextContent("1 PRs");
  });

  it("resizes the comments rail per FEA-1770", async () => {
    // FEA-4233: the resize handle only exists on the open rail; seed a comment so
    // the rail opens once its discovery read settles (the empty-session default
    // is the collapsed handle, which has no resize handle).
    seedSessionTraceComment(populatedAgentSessionDetailFixture.id);
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    await waitFor(() =>
      expect(document.querySelector(".fp-resize")).toBeInTheDocument()
    );

    const shell = document.querySelector<HTMLElement>(".sd3");
    const rail = document.querySelector<HTMLElement>(".sd3-cmts");
    const resizeHandle = document.querySelector<HTMLElement>(".fp-resize");

    if (!(shell && rail && resizeHandle)) {
      throw new Error("Expected the FEA-1770 comments rail resize handle");
    }

    setElementRect(rail, { left: 600, width: 332 });
    Object.defineProperty(shell, "clientWidth", {
      configurable: true,
      value: 900,
    });
    fireEvent.mouseDown(resizeHandle, { clientX: 700 });
    fireEvent.mouseMove(document, { clientX: 600 });
    fireEvent.mouseUp(document);

    await waitFor(() =>
      expect(shell?.style.getPropertyValue("--sd3-cmts-w")).toBe("432px")
    );
  });

  it("keeps long session property preview and expanded values shrinkable", async () => {
    const user = userEvent.setup();
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createAgentSessionDetailFixture({
          primaryModel: LONG_MODEL_NAME,
          repo: LONG_REPOSITORY_NAME,
          repositoryFullName: LONG_REPOSITORY_NAME,
        })}
      />
    );

    const previewModel = screen.getByText(LONG_MODEL_NAME);
    const previewRepository = screen.getByText(LONG_REPOSITORY_NAME);
    expect(previewModel).toHaveClass("truncate");
    expect(previewRepository).toHaveClass("truncate");
    expect(previewModel.closest(".sd3-pp")).toHaveAttribute(
      "title",
      LONG_MODEL_NAME
    );
    expect(previewRepository.closest(".sd3-pp")).toHaveAttribute(
      "title",
      LONG_REPOSITORY_NAME
    );

    await user.click(screen.getByRole("button", { name: "Properties" }));

    // FEA-4026: the expanded non-copyable values live inside the ellipsised
    // `.prd-prop-value-text` span (which inherits the truncate rule) rather than
    // carrying the old hover-only native `title`. Full-value exposure via the
    // shared DS tooltip when clipped is covered by the dedicated suite below.
    const expandedModel = screen
      .getAllByText(LONG_MODEL_NAME)
      .find((el) => el.closest(".prd-prop-value-text"));
    expect(expandedModel?.closest(".prd-prop-value-text")).toBeInTheDocument();
    const expandedRepository = screen
      .getAllByText(LONG_REPOSITORY_NAME)
      .find((el) => el.closest(".prd-prop-value-text"));
    expect(
      expandedRepository?.closest(".prd-prop-value-text")
    ).toBeInTheDocument();
  });

  it("keeps Properties accordion click-only per FEA-1769", async () => {
    const user = userEvent.setup();
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    const props = document.querySelector(".sd3-props");
    const header = screen.getByRole("button", { name: "Properties" });

    expect(props).toHaveAttribute("data-open", "false");
    header.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(props).toHaveAttribute("data-open", "false");

    await user.click(header);
    expect(props).toHaveAttribute("data-open", "true");
  });

  it("keeps null and invalid dates user-safe in derived content", () => {
    const content = buildSessionDetailContent(
      nullDateAgentSessionDetailFixture
    );

    expect(flattenContentText(content)).not.toContain("Invalid Date");
    expect(flattenContentText(content)).not.toContain("NaN");

    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={nullDateAgentSessionDetailFixture}
      />
    );

    expect(screen.getByText("Null date session")).toBeInTheDocument();
    expect(bodyText()).not.toContain("Invalid Date");
    expect(bodyText()).not.toContain("undefined");
    expect(bodyText()).not.toContain("NaN");
  });

  it("groups near-midnight UTC events by the viewer-local calendar date", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const content = buildSessionDetailContent(
        createAgentSessionDetailFixture({
          events: [
            {
              externalEventId: "near-midnight-event",
              agentExternalId: "agent-main",
              eventType: "tool_use",
              toolName: "node",
              summary: "Near-midnight timestamp.",
              createdAt: "2026-01-01T01:30:00.000Z",
            },
          ],
        })
      );

      expect(content.eventData.groups).toHaveLength(1);
      expect(content.eventData.groups[0]).toMatchObject({
        id: "2025-12-31",
        title: "Dec 31, 2025",
      });
      expect(content.eventData.groups[0]?.events[0]?.createdAt).toBe(
        "2026-01-01T01:30:00.000Z"
      );
    } finally {
      restoreTimeZone(originalTz);
    }
  });

  it("renders empty-agent and long-content states without debug copy", () => {
    const { rerender } = renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={emptyAgentsAgentSessionDetailFixture}
      />
    );

    expect(screen.getByText("Empty agent session")).toBeInTheDocument();

    rerender(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={longContentAgentSessionDetailFixture}
        />
      )
    );

    expect(screen.getByText(LONG_SESSION_TITLE)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("debug");
    expect(document.body.textContent).not.toContain("storybook");
  });
});

function makeActivityBucket(
  overrides: Partial<ActivityBucket> & Pick<ActivityBucket, "label" | "tl0">
): ActivityBucket {
  return {
    cIn: 0.5,
    cOut: 0.3,
    cCache: 0.1,
    total: 1,
    toolStart: 0,
    byModel: { "gpt-5.5": { cIn: 0.5, cOut: 0.3, cCache: 0.1 } },
    ...overrides,
  };
}

/*
 * FEA-3414 / FEA-3428: the green (commit/PR) timeline dots showed an
 * inconsistent/missing tooltip and repainted the whole timeline on hover.
 * Root cause: server-persisted `activityBuckets` arrive WITHOUT a `key`
 * (`activityBucketSchema` strips it on ingest), so the value-based key fallback
 * ran — and adjacent idle buckets share identical `label`/`tl0`/counts,
 * collapsing multiple sibling `sd3-dcell` cells onto ONE React key. The
 * duplicate keys made React remount the colliding cells on every hover-driven
 * re-render, flashing the dot rail and resetting the green tooltip's two-phase
 * layout measurement. The fix anchors the key on the bucket's positional index.
 */
describe("green timeline dot tooltip stability (FEA-3414 / FEA-3428)", () => {
  it("shows the same tooltip on a green commit dot that the other dot colors show", async () => {
    const user = userEvent.setup();
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createKeylessBucketGreenDotSession()}
      />
    );

    const greenDot = getOnlyGreenTimelineDot();
    // Same interaction the red-dot suites use — the green dot must resolve its
    // label ("Commits & PRs") and event detail identically.
    await user.hover(greenDot);
    expect(await screen.findByText("Commits & PRs")).toBeInTheDocument();
    expect(screen.getByText("Checkpoint commit")).toBeInTheDocument();
  });

  it("groups the marker swatch and label in the tooltip header", async () => {
    const user = userEvent.setup();
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createKeylessBucketGreenDotSession()}
      />
    );

    await user.hover(getOnlyGreenTimelineDot());
    const label = await screen.findByText("Commits & PRs");
    const labelGroup = label.closest(".sd3-tip-mklabel");

    expect(labelGroup).toBeInTheDocument();
    expect(labelGroup).toHaveTextContent("Commits & PRs");
    expect(labelGroup?.parentElement).toHaveClass("sd3-tip-mkhead");
    expect(labelGroup?.querySelector(".sd3-tip-swatch")).toBeInTheDocument();
  });

  it("derives a unique, stable dot-cell key for keyless server buckets so hover cannot remount the rail", () => {
    // Exactly the payload shape `createKeylessBucketGreenDotSession` renders:
    // keyless server buckets with two identical idle buckets. Before the fix
    // the two idle buckets produced the SAME value-based key (all-zero counts +
    // empty label), collapsing sibling `sd3-dcell` cells onto one React key and
    // remounting them on every hover-driven re-render (the flicker).
    const buckets: (ActivityBucket | undefined)[] = [
      {
        label: "12:00:00",
        cIn: 0.4,
        cOut: 0.3,
        cCache: 0.1,
        total: 3,
        toolStart: 1,
        tl0: 0,
        byModel: {},
      },
      {
        label: "",
        cIn: 0,
        cOut: 0,
        cCache: 0,
        total: 0,
        toolStart: 0,
        tl0: null,
        byModel: {},
      },
      {
        label: "",
        cIn: 0,
        cOut: 0,
        cCache: 0,
        total: 0,
        toolStart: 0,
        tl0: null,
        byModel: {},
      },
    ];

    const keys = buckets.map((bucket, index) => getBucketKey(bucket, index));
    // Unique per cell — the two idle buckets no longer collide.
    expect(new Set(keys).size).toBe(keys.length);
    // Stable across re-renders: same inputs → identical keys, so React never
    // re-keys/remounts the cells on hover.
    const keysAgain = buckets.map((bucket, index) =>
      getBucketKey(bucket, index)
    );
    expect(keysAgain).toEqual(keys);
    // A missing bucket still yields a distinct, positional key (never a shared
    // "missing-bucket" constant that would collide with a sibling).
    expect(getBucketKey(undefined, 4)).toBe("missing-bucket-4");
    expect(getBucketKey(undefined, 4)).not.toBe(getBucketKey(undefined, 5));
  });

  it("does not repaint the dot rail on hover — the same green dot node survives the tooltip re-render", async () => {
    const user = userEvent.setup();
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createKeylessBucketGreenDotSession()}
      />
    );

    const greenDotBefore = getOnlyGreenTimelineDot();
    // Hovering mounts the tooltip and forces the re-render that used to remount
    // the colliding cells. With stable keys the exact same node survives.
    await user.hover(greenDotBefore);
    await screen.findByText("Commits & PRs");
    expect(getOnlyGreenTimelineDot()).toBe(greenDotBefore);
  });
});

// Server-persisted `activityBuckets` carry NO `key` (stripped on ingest), and
// the two middle buckets here are idle with an identical empty label — exactly
// the shape that collided into one React key before FEA-3414. The commit marker
// at x:90 lands in the final bucket, producing a single green timeline dot.
function createKeylessBucketGreenDotSession(): AgentSessionDetail {
  const idleBucket = (label: string): ActivityBucket => ({
    label,
    cIn: 0,
    cOut: 0,
    cCache: 0,
    total: 0,
    toolStart: 0,
    tl0: null,
    byModel: {},
  });
  const activeBucket = (label: string, tl0: number): ActivityBucket => ({
    label,
    cIn: 0.4,
    cOut: 0.3,
    cCache: 0.1,
    total: 3,
    toolStart: 1,
    tl0,
    byModel: { "gpt-5.5": { cIn: 0.4, cOut: 0.3, cCache: 0.1 } },
  });
  return createAgentSessionDetailFixture({
    // No `key` on any bucket — reproduces the server ingest shape. The two idle
    // buckets share an empty label so their value-based keys would collide.
    activityBuckets: [
      activeBucket("12:00:00", 0),
      idleBucket(""),
      idleBucket(""),
      activeBucket("12:16:00", 8),
    ],
    endedAt: new Date("2026-06-10T12:20:00.000Z"),
    events: [],
    markers: [
      {
        kind: "commit",
        label: "Checkpoint commit",
        t: "12:16:00",
        tl: 8,
        x: 90,
      },
    ],
    name: "Green dot key-stability session",
    startedAt: new Date("2026-06-10T12:00:00.000Z"),
    throttles: [],
    throttleSources: [],
    timeline: [],
    turnItems: createLimitTurnItems(),
    updatedAt: new Date("2026-06-10T12:20:00.000Z"),
  });
}

function getOnlyGreenTimelineDot(): HTMLElement {
  const greenDots = document.querySelectorAll<HTMLElement>(
    ".sd3-drail .sd3-dot.d-g"
  );
  if (greenDots.length !== 1) {
    throw new Error(
      `Expected one green timeline dot, found ${greenDots.length}`
    );
  }
  return greenDots[0]!;
}

function getOnlyTimelineDot(color: "b" | "g" | "r"): HTMLElement {
  const dots = document.querySelectorAll<HTMLElement>(
    `.sd3-drail .sd3-dot.d-${color}`
  );
  if (dots.length !== 1) {
    throw new Error(
      `Expected one "${color}" timeline dot, found ${dots.length}`
    );
  }
  return dots[0]!;
}

function getOnlyRedTimelineDot(): HTMLElement {
  return getOnlyTimelineDot("r");
}

function createLimitDotSession(
  overrides: Partial<AgentSessionDetail> = {}
): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    activityBuckets: [],
    endedAt: new Date("2026-06-10T12:20:00.000Z"),
    events: [
      {
        agentExternalId: "agent-main",
        createdAt: LIMIT_EVENT_TIME,
        eventType: SessionTraceThrottleSourceType.UsageLimit,
        externalEventId: "limit-event",
        summary: "Usage limit reached.",
      },
    ],
    markers: [
      {
        kind: "prompt",
        label: "Initial prompt",
        t: "12:01:00",
        tl: 0,
        x: 5,
      },
      {
        kind: "commit",
        label: "Checkpoint commit",
        t: "12:16:00",
        tl: 8,
        x: 80,
      },
    ],
    name: "Limit marker session",
    startedAt: new Date("2026-06-10T12:00:00.000Z"),
    throttles: [],
    timeline: [
      {
        kind: "event",
        t: LIMIT_EVENT_TIME,
        tMs: Date.parse(LIMIT_EVENT_TIME),
        title: SessionTraceThrottleSourceType.UsageLimit,
        tl: LIMIT_EVENT_ROW,
      },
    ],
    turnItems: createLimitTurnItems(),
    updatedAt: new Date("2026-06-10T12:20:00.000Z"),
    ...overrides,
  });
}

function createLimitTurnItems(): NonNullable<AgentSessionDetail["turnItems"]> {
  const { agentActor, humanActor } = createLimitActors();

  return [
    {
      _row: 0,
      actor: humanActor,
      cum: 0,
      t: "2026-06-10T12:01:00.000Z",
      tMs: Date.parse("2026-06-10T12:01:00.000Z"),
      text: "Start the session limit investigation.",
      type: "prompt",
    },
    {
      _row: 5,
      actor: agentActor,
      cum: 0.01,
      model: "gpt-5.5",
      t: "2026-06-10T12:08:00.000Z",
      tMs: Date.parse("2026-06-10T12:08:00.000Z"),
      text: "Checking provider behavior before the limit.",
      type: "say",
    },
    {
      _row: LIMIT_EVENT_ROW,
      dot: "r",
      t: LIMIT_EVENT_TIME,
      tMs: Date.parse(LIMIT_EVENT_TIME),
      tag: SessionTraceThrottleSourceType.UsageLimit,
      text: "Usage limit reached.",
      type: "event",
    },
    {
      _row: 8,
      actor: agentActor,
      cum: 0.02,
      model: "gpt-5.5",
      t: "2026-06-10T12:16:00.000Z",
      tMs: Date.parse("2026-06-10T12:16:00.000Z"),
      text: "The session resumed after the limit window.",
      type: "say",
    },
    {
      text: "Session completed.",
      type: "end",
    },
  ];
}

function createRateLimitProseTurnItems(): NonNullable<
  AgentSessionDetail["turnItems"]
> {
  const { agentActor, humanActor } = createLimitActors();

  return [
    {
      _row: 0,
      actor: humanActor,
      cum: 0,
      t: "2026-06-10T12:01:00.000Z",
      tMs: Date.parse("2026-06-10T12:01:00.000Z"),
      text: "Start the ordinary prose regression.",
      type: "prompt",
    },
    {
      _row: 5,
      actor: agentActor,
      cum: 0.01,
      model: "gpt-5.5",
      t: "2026-06-10T12:08:00.000Z",
      tMs: Date.parse("2026-06-10T12:08:00.000Z"),
      text: "We should document how rate limit messaging works later.",
      type: "say",
    },
    {
      text: "Session completed.",
      type: "end",
    },
  ];
}

function createSameTimestampLimitTurnItems(): NonNullable<
  AgentSessionDetail["turnItems"]
> {
  const { agentActor, humanActor } = createLimitActors();

  return [
    {
      _row: 0,
      actor: humanActor,
      cum: 0,
      t: "2026-06-10T12:01:00.000Z",
      tMs: Date.parse("2026-06-10T12:01:00.000Z"),
      text: "Start the same-timestamp row regression.",
      type: "prompt",
    },
    {
      _row: 6,
      actor: agentActor,
      cum: 0.01,
      model: "gpt-5.5",
      t: LIMIT_EVENT_TIME,
      tMs: Date.parse(LIMIT_EVENT_TIME),
      text: "Adjacent non-limit row with the same timestamp.",
      type: "say",
    },
    {
      // FEA-3642: a structured harness limit event — its `tag` (`usage_limit`),
      // not free-text prose, is what classifies it as a limit.
      _row: LIMIT_EVENT_ROW,
      dot: "r",
      t: LIMIT_EVENT_TIME,
      tMs: Date.parse(LIMIT_EVENT_TIME),
      tag: SessionTraceThrottleSourceType.UsageLimit,
      text: "Provider paused.",
      type: "event",
    },
    {
      text: "Session completed.",
      type: "end",
    },
  ];
}

function createThrottleMentionFailureTurnItems(): NonNullable<
  AgentSessionDetail["turnItems"]
> {
  const { humanActor } = createLimitActors();

  return [
    {
      _row: 0,
      actor: humanActor,
      cum: 0,
      t: "2026-06-10T12:01:00.000Z",
      tMs: Date.parse("2026-06-10T12:01:00.000Z"),
      text: "Start the throttle-mention failure regression.",
      type: "prompt",
    },
    {
      // A genuine failure (`dot: "r"`) whose free-text prose merely discusses
      // throttling/429 — its structured `tag` is not a limit type, so it must
      // stay a plain failure, never a limit indicator.
      _row: LIMIT_EVENT_ROW,
      dot: "r",
      t: LIMIT_EVENT_TIME,
      tMs: Date.parse(LIMIT_EVENT_TIME),
      tag: "tool_error",
      text: "The tool failed; the agent noted it might be throttled with a 429.",
      type: "event",
    },
    {
      text: "Session completed.",
      type: "end",
    },
  ];
}

function createNeutralLimitTargetTurnItems(): NonNullable<
  AgentSessionDetail["turnItems"]
> {
  const { agentActor, humanActor } = createLimitActors();

  return [
    {
      _row: 0,
      actor: humanActor,
      cum: 0,
      t: "2026-06-10T12:01:00.000Z",
      tMs: Date.parse("2026-06-10T12:01:00.000Z"),
      text: "Start the generic event summary regression.",
      type: "prompt",
    },
    {
      _row: LIMIT_EVENT_ROW,
      actor: agentActor,
      cum: 0.01,
      model: "gpt-5.5",
      t: LIMIT_EVENT_TIME,
      tMs: Date.parse(LIMIT_EVENT_TIME),
      text: "The provider returned an error.",
      type: "say",
    },
    {
      text: "Session completed.",
      type: "end",
    },
  ];
}

function createLimitActors() {
  return {
    agentActor: {
      color: "var(--primary)",
      harness: "codex",
      human: null,
      name: "gpt-5.5",
      sessionId: "limit-session",
    },
    humanActor: {
      color: "hsl(210 65% 45%)",
      human: "Ada Lovelace",
      name: null,
      sessionId: "limit-session",
    },
  };
}

function renderDetail(ui: React.ReactElement) {
  return render(withProviders(ui));
}

describe("FEA-3419 cache-write TTL breakdown row", () => {
  // FEA-3419: the row derives from the TYPED per-model token usage (the
  // metadata blob reader is gone) — same shape on web (cloud columns) and
  // desktop (local columns).
  const cacheSplitFixture = createAgentSessionDetailFixture({
    tokenUsageByModel: [
      {
        model: "claude-opus-4-5",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 4608,
        cacheWrite5mTokens: 4096,
        cacheWrite1hTokens: 512,
      },
    ],
  });

  async function openProperties() {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Properties" }));
  }

  it("renders the 5m vs 1h split when the typed usage carries it", async () => {
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={cacheSplitFixture}
        />
      )
    );

    await openProperties();

    const label = screen.getByText("Cache Write");
    expect(label.closest(".prd-prop")).toHaveTextContent(
      "Cache Write4,096 (5m TTL) | 512 (1h TTL)"
    );
  });

  it("hides the row when the session reports no split", async () => {
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={populatedAgentSessionDetailFixture}
        />
      )
    );

    await openProperties();

    expect(screen.queryByText("Cache Write")).not.toBeInTheDocument();
  });
});

describe("ISS-4418 session detail Cost property honesty", () => {
  async function openProperties() {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Properties" }));
  }

  // A genuinely zero-usage session: no cost, no turns, no tokens, no tool uses,
  // and a subscription billing mode. The fixture default carries a real
  // `cost: "$4.82"` display string, so this proves the Properties Cost row is
  // routed through the derived label (`deriveSessionCostLabel`) and reads the
  // honest `—`, not the raw `session.cost` dollar value that would contradict
  // the Cost metric card above it.
  const zeroUsageSubscriptionFixture = createAgentSessionDetailFixture({
    billingMode: "pro",
    cost: "$4.82",
    estimatedCost: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolUseCount: 0,
    tokenUsageByModel: [],
  });

  /*
   * ISS-5072: the COLLAPSED preview's Cost chip used to read the detail-content
   * builder's Cost metric (`content.metrics[2]`) — the one field the shipped
   * view consumed out of a view-model built over every session event. It now
   * calls `deriveSessionCostLabel` directly; this pins that the rendered string
   * is the same honest derived label, so the swap cannot regress into the raw
   * `session.cost` the fixture carries.
   */
  it("renders the derived Cost label in the collapsed Properties preview", () => {
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={zeroUsageSubscriptionFixture}
        />
      )
    );

    const preview = document.querySelector(".sd3-props-preview");
    expect(preview).toHaveTextContent("—");
    expect(preview).not.toHaveTextContent("$4.82");
    expect(preview).not.toHaveTextContent("$0.00");
  });

  it("renders — for a zero-usage subscription session, not the raw session.cost", async () => {
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={zeroUsageSubscriptionFixture}
        />
      )
    );

    await openProperties();

    // "Cost" appears in both the metric card and the Properties list, so scope
    // to the Properties row whose label is exactly "Cost".
    const costLabel = Array.from(
      document.querySelectorAll(".prd-prop-label")
    ).find((label) => label.textContent === "Cost");
    const costRow = costLabel?.closest(".prd-prop");
    expect(costRow).toHaveTextContent("Cost—");
    expect(costRow).not.toHaveTextContent("$4.82");
    expect(costRow).not.toHaveTextContent("$0.00");
  });
});

function bodyText() {
  return document.body.textContent ?? "";
}

function flattenContentText(content: AgentSessionDetailContent): string {
  return JSON.stringify(content);
}

function setElementRect(
  element: HTMLElement | null,
  rect: Pick<DOMRect, "left" | "width"> &
    Partial<Pick<DOMRect, "height" | "top">>
) {
  if (!element) {
    return;
  }
  const top = rect.top ?? 0;
  const height = rect.height ?? 0;
  element.getBoundingClientRect = () =>
    ({
      bottom: top + height,
      height,
      left: rect.left,
      right: rect.left + rect.width,
      top,
      width: rect.width,
      x: rect.left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function getSessionTimelineTrackerLeft(): string | null {
  return (
    document.querySelector<HTMLElement>(".sd3-bars2-wrap .tl-here")?.style
      .left ?? null
  );
}
