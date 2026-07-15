import {
  type AgentSessionDetail,
  SessionTraceThrottleSourceType,
} from "@repo/api/src/types/agent-session";
import type {
  TraceComment,
  TraceCommentDraft,
  TraceCommentTarget,
} from "@repo/api/src/types/comment";
import { createFakeTraceCommentsSource } from "@repo/app/agents/data-source/__tests__/fake-trace-comments-source";
import type { TraceCommentsDataSource } from "@repo/app/agents/data-source/trace-comments-data-source";
import { TraceCommentsDataSourceProvider } from "@repo/app/agents/data-source/trace-comments-provider";
import { SESSION_COMMENTS_RAIL_COLLAPSE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import {
  createAgentSessionDetailFixture,
  emptyAgentsAgentSessionDetailFixture,
  longContentAgentSessionDetailFixture,
  nullDateAgentSessionDetailFixture,
  populatedAgentSessionDetailFixture,
} from "../agent-session-detail-fixtures";
import {
  AgentSessionDetailView,
  buildActivityMarkers,
} from "../agent-session-detail-view";
import {
  type AgentSessionDetailContent,
  buildSessionDetailContent,
} from "../detail-content";
import {
  EXPECTED_CLAUDE_CODE_PROPERTY_LABELS,
  expectExactClaudeCodePropertyLabels,
} from "./property-label-contract";

const BACK_TO_SESSIONS_LINK_NAME = /back to sessions/i;
const LONG_SESSION_TITLE = /A very long shared agent session detail title/;
const SUBAGENT_REVIEW_LANE_BUTTON_NAME = /subagent.*review lane/i;
const INLINE_TRACE_COMMENT_PLACEHOLDER = /comment on this passage/i;
// Matches the inline trace affordance exactly so it never collides with the
// rail's "Collapse comments panel" / "Show comments panel" controls (FEA-2479).
const COMMENT_BUTTON_NAME_RE = /^comment$/i;
const DUPLICATE_TOOLS_BUTTON_NAME = /Ran 2 tools/i;
const JUMP_TO_ACTIVITY_BUCKET_NAME = /jump to activity bucket/i;
const JUMP_TO_FAILURES_NAME = /jump to failures & limits/i;
const PR_1634_OPEN_LINK_NAME = /1634\s*open/i;
const COPY_SESSION_ID_BUTTON_NAME = /copy session id/i;
const THROTTLED_FOR_FIVE_MINUTES_TEXT = /Throttled for 5m/;
const PERCENT_STYLE_VALUE_REGEX = /%$/;
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
const traceCommentsByTarget = new Map<string, TraceComment[]>();
const fakeTraceCommentsSource = createFakeTraceCommentsSource({
  commentsByTarget: traceCommentsByTarget,
  makeTraceComment,
});

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  traceCommentsByTarget.clear();
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

describe("buildActivityMarkers timeline dot kinds (FEA-2192)", () => {
  it("does not tag successful tool or subagent turns as human steering", () => {
    const base = createAgentSessionDetailFixture();
    // Force the turnItems fallback (server markers absent) and flip the failing
    // tool/subagent turns to successful completions.
    const session = {
      ...base,
      markers: [],
      turnItems: (base.turnItems ?? []).map((item) => {
        if (item.type === "tools") {
          return {
            ...item,
            hasFail: false,
            failN: 0,
            items: item.items.map((tool) => ({ ...tool, err: false })),
          };
        }
        if (item.type === "subagent") {
          return { ...item, status: "completed" };
        }
        return item;
      }),
    };

    const markers = buildActivityMarkers(session);

    // The genuine human prompt (row 0) is the only "Human steering" marker.
    expect(markers.filter((m) => m.kind === "prompt").map((m) => m.tl)).toEqual(
      [0]
    );
    // Successful tool (row 3) and subagent (row 5) turns produce no marker — same
    // as the server-side buildTraceMarkers path.
    expect(markers.some((m) => m.tl === 3)).toBe(false);
    expect(markers.some((m) => m.tl === 5)).toBe(false);
  });

  it("still surfaces failed tool and subagent turns as failures", () => {
    const markers = buildActivityMarkers(createAgentSessionDetailFixture());

    expect(markers.find((m) => m.tl === 3)?.kind).toBe("fail");
    expect(markers.find((m) => m.tl === 5)?.kind).toBe("fail");
    // Failures are never mislabeled as human steering.
    expect(markers.filter((m) => m.kind === "prompt").map((m) => m.tl)).toEqual(
      [0]
    );
  });

  it('marks a subagent turn with cloud status "error" as a failure', () => {
    const base = createAgentSessionDetailFixture();
    const session = {
      ...base,
      markers: [],
      turnItems: (base.turnItems ?? []).map((item) =>
        item.type === "subagent" ? { ...item, status: "error" } : item
      ),
    };

    const markers = buildActivityMarkers(session);

    // "error" is the canonical cloud-source failure status; the subagent (row 5)
    // must still surface a failure marker, not be silently dropped.
    expect(markers.find((m) => m.tl === 5)?.kind).toBe("fail");
  });
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

  it("renders populated detail without invalid placeholder leaks", () => {
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
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
    expect(document.querySelectorAll(".sd3-bar2.idle").length).toBeGreaterThan(
      0
    );
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
      "20m",
      "18m",
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

  it("scales the timeline axis to the session duration, rounded up per FEA-2029", () => {
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createAgentSessionDetailFixture({
          startedAt: new Date("2026-06-10T12:00:00.000Z"),
          endedAt: new Date("2026-06-10T12:05:05.000Z"),
        })}
      />
    );

    const axisScale = document.querySelector<HTMLElement>(
      ".sd3-act-axis span[title]"
    );
    expect(axisScale).toHaveTextContent("6m");
    expect(axisScale).toHaveAttribute(
      "title",
      "Total session duration, rounded up to the nearest minute"
    );
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

    await user.click(
      screen.getAllByRole("button", {
        name: JUMP_TO_ACTIVITY_BUCKET_NAME,
      })[2]
    );

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
    expect(
      screen.getByText(SessionTraceThrottleSourceType.UsageLimit)
    ).toBeInTheDocument();

    await user.click(redDot);
    expect(document.querySelector(".st-flash")).toHaveAttribute(
      "data-row",
      String(LIMIT_EVENT_ROW)
    );
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
      screen.getByText("No activity buckets were captured for this session.")
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

  it("prefers explicit timeline rows when timestamped trace rows collide", async () => {
    const user = userEvent.setup();
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={createLimitDotSession({
          events: [],
          timeline: [
            {
              kind: "event",
              t: LIMIT_EVENT_TIME,
              tMs: Date.parse(LIMIT_EVENT_TIME),
              title: SessionTraceThrottleSourceType.UsageLimit,
              tl: LIMIT_EVENT_ROW,
            },
          ],
          turnItems: createSameTimestampNeutralTurnItems(),
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

  it("keeps the FEA-1770 comments resize handle non-focusable and source-shaped", () => {
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
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
    await waitFor(() => {
      expect(screen.queryByText("First session note")).not.toBeInTheDocument();
      expect(screen.getByText("No trace comments yet")).toBeInTheDocument();
    });
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

  it("resizes the comments rail per FEA-1770", async () => {
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
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

    expect(screen.getByText(LONG_MODEL_NAME)).toHaveAttribute(
      "title",
      LONG_MODEL_NAME
    );
    expect(screen.getByText(LONG_REPOSITORY_NAME)).toHaveAttribute(
      "title",
      LONG_REPOSITORY_NAME
    );
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

function getOnlyRedTimelineDot(): HTMLElement {
  const redDots = document.querySelectorAll<HTMLElement>(
    ".sd3-drail .sd3-dot.d-r"
  );
  if (redDots.length !== 1) {
    throw new Error(`Expected one red timeline dot, found ${redDots.length}`);
  }
  return redDots[0]!;
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

function createSameTimestampNeutralTurnItems(): NonNullable<
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
      _row: LIMIT_EVENT_ROW,
      dot: "r",
      t: LIMIT_EVENT_TIME,
      tMs: Date.parse(LIMIT_EVENT_TIME),
      tag: "status",
      text: "Provider paused.",
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

const COLLAPSE_COMMENTS_BUTTON_NAME = /collapse comments panel/i;
const SHOW_COMMENTS_BUTTON_NAME = /show comments panel/i;

describe("collapsible comments rail (FEA-2479)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("collapses the rail into a re-open handle and widens the main content", async () => {
    const user = userEvent.setup();
    renderCollapsibleDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        commentsRailOpen
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    expect(document.querySelector(".sd3-cmts")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: COLLAPSE_COMMENTS_BUTTON_NAME })
    );

    expect(document.querySelector(".sd3-cmts")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: SHOW_COMMENTS_BUTTON_NAME })
    ).toBeInTheDocument();
    // The main trace content survives the collapse and stays readable.
    expect(screen.getByText("Session Trace")).toBeInTheDocument();
  });

  it("re-opens the rail from the collapsed handle", async () => {
    const user = userEvent.setup();
    renderCollapsibleDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        commentsRailOpen
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    await user.click(
      screen.getByRole("button", { name: COLLAPSE_COMMENTS_BUTTON_NAME })
    );
    await user.click(
      screen.getByRole("button", { name: SHOW_COMMENTS_BUTTON_NAME })
    );

    expect(document.querySelector(".sd3-cmts")).toBeInTheDocument();
  });

  it("remembers the collapsed preference across remounts", async () => {
    const user = userEvent.setup();
    const { unmount } = renderCollapsibleDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        commentsRailOpen
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    await user.click(
      screen.getByRole("button", { name: COLLAPSE_COMMENTS_BUTTON_NAME })
    );
    unmount();

    renderCollapsibleDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        commentsRailOpen
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    expect(document.querySelector(".sd3-cmts")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: SHOW_COMMENTS_BUTTON_NAME })
    ).toBeInTheDocument();
  });

  it("keeps the rail permanently open with no collapse control when the flag is off", () => {
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        commentsRailOpen
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    expect(document.querySelector(".sd3-cmts")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: COLLAPSE_COMMENTS_BUTTON_NAME })
    ).not.toBeInTheDocument();
  });

  it("re-opens a collapsed rail when a trace comment is anchored (FEA-2480)", async () => {
    const user = userEvent.setup();
    renderCollapsibleDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        commentsRailOpen
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    await user.click(
      screen.getByRole("button", { name: COLLAPSE_COMMENTS_BUTTON_NAME })
    );
    expect(document.querySelector(".sd3-cmts")).not.toBeInTheDocument();

    selectRenderedText(document.body, "shared session detail screen");
    fireEvent.mouseUp(document.querySelector(".st") as HTMLElement);
    await user.click(
      screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    );
    await user.type(
      screen.getByPlaceholderText(INLINE_TRACE_COMMENT_PLACEHOLDER),
      "Anchored while collapsed"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(document.querySelector(".sd3-cmts")).toBeInTheDocument();
    expect(screen.getByText("Anchored while collapsed")).toBeInTheDocument();
    // The reveal is transient: the reader's saved collapse preference survives.
    expect(localStorage.getItem("sessions:comments-rail:collapsed")).toBe(
      "true"
    );
  });

  it("restores the saved collapsed preference on remount after a transient reveal", async () => {
    const user = userEvent.setup();
    const { unmount } = renderCollapsibleDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        commentsRailOpen
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    await user.click(
      screen.getByRole("button", { name: COLLAPSE_COMMENTS_BUTTON_NAME })
    );
    selectRenderedText(document.body, "shared session detail screen");
    fireEvent.mouseUp(document.querySelector(".st") as HTMLElement);
    await user.click(
      screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    );
    await user.type(
      screen.getByPlaceholderText(INLINE_TRACE_COMMENT_PLACEHOLDER),
      "Anchored while collapsed"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));
    expect(document.querySelector(".sd3-cmts")).toBeInTheDocument();
    unmount();

    renderCollapsibleDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        commentsRailOpen
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    // Reload respects the durable preference, not the transient reveal.
    expect(document.querySelector(".sd3-cmts")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: SHOW_COMMENTS_BUTTON_NAME })
    ).toBeInTheDocument();
  });

  it("keeps a collapsed rail collapsed when the trace comment submission fails", async () => {
    const user = userEvent.setup();
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          commentsRailOpen
          isLoading={false}
          session={populatedAgentSessionDetailFixture}
        />,
        [SESSION_COMMENTS_RAIL_COLLAPSE_FEATURE_FLAG_KEY],
        failingTraceCommentsSource
      )
    );

    await user.click(
      screen.getByRole("button", { name: COLLAPSE_COMMENTS_BUTTON_NAME })
    );
    expect(document.querySelector(".sd3-cmts")).not.toBeInTheDocument();

    selectRenderedText(document.body, "shared session detail screen");
    fireEvent.mouseUp(document.querySelector(".st") as HTMLElement);
    await user.click(
      screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    );
    await user.type(
      screen.getByPlaceholderText(INLINE_TRACE_COMMENT_PLACEHOLDER),
      "Submission that fails"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));

    // The create mutation rejected, so the reveal must not fire: the rail the
    // reader collapsed stays collapsed rather than popping open optimistically.
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(document.querySelector(".sd3-cmts")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: SHOW_COMMENTS_BUTTON_NAME })
    ).toBeInTheDocument();
  });

  it("re-opens a collapsed rail when the header 'Show comments rail' toggle turns on", async () => {
    const user = userEvent.setup();
    const { rerender } = renderCollapsibleDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        commentsRailOpen
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    await user.click(
      screen.getByRole("button", { name: COLLAPSE_COMMENTS_BUTTON_NAME })
    );
    expect(document.querySelector(".sd3-cmts")).not.toBeInTheDocument();

    // Header toggle closes the rail entirely, then re-opens it. The persisted
    // collapse=true must not silently override the header's authoritative open.
    rerender(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          commentsRailOpen={false}
          isLoading={false}
          session={populatedAgentSessionDetailFixture}
        />,
        [SESSION_COMMENTS_RAIL_COLLAPSE_FEATURE_FLAG_KEY]
      )
    );
    rerender(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          commentsRailOpen
          isLoading={false}
          session={populatedAgentSessionDetailFixture}
        />,
        [SESSION_COMMENTS_RAIL_COLLAPSE_FEATURE_FLAG_KEY]
      )
    );

    await waitFor(() =>
      expect(document.querySelector(".sd3-cmts")).toBeInTheDocument()
    );
    // The header toggle also clears the durable preference so the full panel is
    // authoritative, not just transiently revealed.
    expect(localStorage.getItem("sessions:comments-rail:collapsed")).toBe(
      "false"
    );
  });
});

function renderDetail(ui: React.ReactElement) {
  return render(withProviders(ui));
}

// Renders with the FEA-2479 collapse flag enabled so the collapse control is present.
function renderCollapsibleDetail(ui: React.ReactElement) {
  return render(
    withProviders(ui, [SESSION_COMMENTS_RAIL_COLLAPSE_FEATURE_FLAG_KEY])
  );
}

function withProviders(
  ui: React.ReactElement,
  enabledFlags?: readonly string[],
  dataSource: TraceCommentsDataSource = fakeTraceCommentsSource
) {
  return (
    <AppCoreStoryProviders enabledFlags={enabledFlags}>
      <TraceCommentsDataSourceProvider dataSource={dataSource}>
        {ui}
      </TraceCommentsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

// A data source whose create() always rejects, to assert that a failed trace
// comment submission never reveals a collapsed rail (FEA-2479).
const failingTraceCommentsSource: TraceCommentsDataSource = {
  ...fakeTraceCommentsSource,
  create: () => Promise.reject(new Error("create failed")),
};

function makeTraceComment(
  target: TraceCommentTarget,
  draft: TraceCommentDraft,
  index: number
): TraceComment {
  const createdAt = new Date(Date.UTC(2026, 5, 17, 10, index)).toISOString();
  return {
    id: `${target.type}-trace-comment-${index}`,
    threadId: `${target.type}-trace-thread-${index}`,
    target,
    artifactId: target.id,
    surface: target.type === "session" ? "session_detail" : "branch_detail",
    ...draft,
    status: "OPEN",
    createdAt,
    updatedAt: createdAt,
    editedAt: null,
    authorId: "user-test",
    authorName: "Test User",
    authorAvatarUrl: null,
    canEdit: true,
    canDelete: true,
    replies: [],
  };
}

function bodyText() {
  return document.body.textContent ?? "";
}

function flattenContentText(content: AgentSessionDetailContent): string {
  return JSON.stringify(content);
}

function selectRenderedText(container: HTMLElement, text: string): void {
  const node = findTextNode(container, text);
  if (!node) {
    throw new Error(`Unable to find text node: ${text}`);
  }
  const value = node.textContent ?? "";
  const start = value.indexOf(text);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + text.length);
  const selection = globalThis.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function findTextNode(node: Node, text: string): Text | null {
  if (node.nodeType === Node.TEXT_NODE && node.textContent?.includes(text)) {
    return node as Text;
  }
  for (const child of Array.from(node.childNodes)) {
    const found = findTextNode(child, text);
    if (found) {
      return found;
    }
  }
  return null;
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
