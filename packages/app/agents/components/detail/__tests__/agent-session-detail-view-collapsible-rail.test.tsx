import { toast } from "@repo/design-system/components/ui/sonner";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { populatedAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import {
  COLLAPSE_COMMENTS_BUTTON_NAME,
  COMMENT_BUTTON_NAME_RE,
  failingTraceCommentsSource,
  INLINE_TRACE_COMMENT_PLACEHOLDER,
  resetTraceComments,
  SHOW_COMMENTS_BUTTON_NAME,
  seedSessionTraceComment,
  selectRenderedText,
  withProviders,
} from "./agent-session-detail-view.test-helpers";

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
});

describe("collapsible comments rail (FEA-2479)", () => {
  beforeEach(() => {
    localStorage.clear();
    // FEA-4233 defaults the rail collapsed only when the session has ZERO trace
    // comments. These specs exercise the collapse/expand interaction, which needs
    // the rail to start open, so seed one persisted comment on the fixture's
    // target. (The empty-default behavior itself is covered in its own describe.)
    seedSessionTraceComment(populatedAgentSessionDetailFixture.id);
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

    // FEA-4233: the seeded comment opens the rail once its discovery read
    // settles, so await the collapse control before exercising it.
    await user.click(
      await screen.findByRole("button", { name: COLLAPSE_COMMENTS_BUTTON_NAME })
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
      await screen.findByRole("button", { name: COLLAPSE_COMMENTS_BUTTON_NAME })
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
      await screen.findByRole("button", { name: COLLAPSE_COMMENTS_BUTTON_NAME })
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

  it("ships the collapse control by default now the rail is permanently collapsible (FEA-4002)", async () => {
    renderCollapsibleDetail(
      <AgentSessionDetailView
        backHref="/sessions"
        commentsRailOpen
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    // FEA-4233: the seeded comment opens the rail once its discovery read
    // settles, surfacing the collapse control.
    expect(
      await screen.findByRole("button", {
        name: COLLAPSE_COMMENTS_BUTTON_NAME,
      })
    ).toBeInTheDocument();
    expect(document.querySelector(".sd3-cmts")).toBeInTheDocument();
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
      await screen.findByRole("button", { name: COLLAPSE_COMMENTS_BUTTON_NAME })
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
      await screen.findByRole("button", { name: COLLAPSE_COMMENTS_BUTTON_NAME })
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
        undefined,
        failingTraceCommentsSource
      )
    );

    await user.click(
      await screen.findByRole("button", { name: COLLAPSE_COMMENTS_BUTTON_NAME })
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
      await screen.findByRole("button", { name: COLLAPSE_COMMENTS_BUTTON_NAME })
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
        />
      )
    );
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

// FEA-4002: the collapse control is now permanent (flag graduated), so the
// collapsible-rail specs render exactly like any other detail view.
function renderCollapsibleDetail(ui: React.ReactElement) {
  return render(withProviders(ui));
}
