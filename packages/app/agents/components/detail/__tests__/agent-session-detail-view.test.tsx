import { restoreTimeZone } from "@repo/app/shared/test-fixtures/tz-utils";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import {
  createAgentSessionDetailFixture,
  emptyAgentsAgentSessionDetailFixture,
  longContentAgentSessionDetailFixture,
  nullDateAgentSessionDetailFixture,
  populatedAgentSessionDetailFixture,
} from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
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
const COMMENT_ON_TRACE_PLACEHOLDER = /comment, or @ai/i;
const DUPLICATE_TOOLS_BUTTON_NAME = /Ran 2 tools/i;
const JUMP_TO_ACTIVITY_BUCKET_NAME = /jump to activity bucket/i;
const JUMP_TO_FAILURES_NAME = /jump to failures & limits/i;
const COMMENTING_ON_HINT = /Commenting on/i;
const REVIEW_LANE_TEXT = /Review lane/i;
const PR_1634_OPEN_LINK_NAME = /1634\s*open/i;
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
          issues: ["FEA-1707"],
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
      "closedloop-ai/symphony-alpha",
      "fea-1707",
      "FEA-1707",
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
    expect(firstCost).toHaveTextContent("$1.14");
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
    expect(screen.getByText(COMMENTING_ON_HINT)).toBeInTheDocument();

    await user.click(
      screen.getAllByRole("button", {
        name: JUMP_TO_FAILURES_NAME,
      })[0]
    );
    await user.type(
      screen.getByPlaceholderText(COMMENT_ON_TRACE_PLACEHOLDER),
      "@ai summarize the failed tool"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));
    expect(
      screen.getByText("@ai summarize the failed tool")
    ).toBeInTheDocument();

    document.querySelector(".st-flash")?.classList.remove("st-flash");
    await user.click(screen.getByText("@ai summarize the failed tool"));
    expect(document.querySelector(".st-flash")).toHaveAttribute(
      "data-row",
      "3"
    );
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

  it("keeps FEA-1770 drag handles non-focusable and source-shaped", () => {
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    const playhead = document.querySelector<HTMLElement>(".sd3-playhead");
    const resizeHandle = document.querySelector<HTMLElement>(".fp-resize");

    expect(playhead?.tagName).toBe("DIV");
    expect(playhead?.tabIndex).toBe(-1);
    expect(playhead).not.toHaveAttribute("role");
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

  it("preserves local trace comments when the route header hides and reopens the rail", async () => {
    const user = userEvent.setup();
    const { rerender } = renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        commentsRailOpen
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    await user.type(
      screen.getByPlaceholderText(COMMENT_ON_TRACE_PLACEHOLDER),
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

  it("scrubs the playhead and resizes the comments rail per FEA-1770", async () => {
    renderDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    const shell = document.querySelector<HTMLElement>(".sd3");
    const rail = document.querySelector<HTMLElement>(".sd3-cmts");
    const playhead = document.querySelector<HTMLElement>(".sd3-playhead");
    const resizeHandle = document.querySelector<HTMLElement>(".fp-resize");
    const barsWrap = document.querySelector<HTMLElement>(".sd3-bars2-wrap");

    if (!(shell && rail && playhead && resizeHandle && barsWrap)) {
      throw new Error("Expected FEA-1770 timeline and comments rail handles");
    }

    setElementRect(barsWrap, { left: 0, width: 100 });
    fireEvent.pointerDown(playhead, { clientX: 0 });
    fireEvent.pointerMove(document, { clientX: 99 });
    fireEvent.pointerUp(document);
    expect(screen.getByText(REVIEW_LANE_TEXT)).toBeInTheDocument();

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

function renderDetail(ui: React.ReactElement) {
  return render(withProviders(ui));
}

function withProviders(ui: React.ReactElement) {
  return <AppCoreStoryProviders>{ui}</AppCoreStoryProviders>;
}

function bodyText() {
  return document.body.textContent ?? "";
}

function flattenContentText(content: AgentSessionDetailContent): string {
  return JSON.stringify(content);
}

function setElementRect(
  element: HTMLElement | null,
  rect: Pick<DOMRect, "left" | "width">
) {
  if (!element) {
    return;
  }
  element.getBoundingClientRect = () =>
    ({
      bottom: 0,
      height: 0,
      left: rect.left,
      right: rect.left + rect.width,
      top: 0,
      width: rect.width,
      x: rect.left,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}
