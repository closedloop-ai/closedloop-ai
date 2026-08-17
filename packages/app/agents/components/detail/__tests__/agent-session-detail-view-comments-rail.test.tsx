import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { populatedAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import {
  COLLAPSE_COMMENTS_BUTTON_NAME,
  COMMENT_BUTTON_NAME_RE,
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

// FEA-4233: the comments rail defaults to its slim re-open handle until the
// discovery read confirms the session actually has trace comments, so a
// zero-comment session (the common case) never flashes a 360px panel open only
// to snap it shut once an empty read settles. Colocated here so the substantive
// rail behavior lives in a focused file rather than growing the grandfathered
// agent-session-detail-view.test.tsx.
describe("comments rail empty default (FEA-4233)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    resetTraceComments();
    vi.restoreAllMocks();
  });

  it("defaults the rail to the collapsed handle for a zero-comment session", async () => {
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          commentsRailOpen
          isLoading={false}
          session={populatedAgentSessionDetailFixture}
        />
      )
    );

    // Once the discovery read settles empty, the rail folds to the slim re-open
    // handle instead of an open 360px panel reading "No trace comments yet".
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: SHOW_COMMENTS_BUTTON_NAME })
      ).toBeInTheDocument();
    });
    expect(document.querySelector(".sd3-cmts")).not.toBeInTheDocument();
    expect(screen.queryByText("No trace comments yet")).not.toBeInTheDocument();
    // The empty default never persists a preference — it is a live derivation.
    expect(localStorage.getItem("sessions:comments-rail:collapsed")).toBeNull();
  });

  it("expands the empty rail when the first trace comment is anchored", async () => {
    const user = userEvent.setup();
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          commentsRailOpen
          isLoading={false}
          session={populatedAgentSessionDetailFixture}
        />
      )
    );

    // Starts collapsed (empty), reusing the reveal-on-submit wiring to open.
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: SHOW_COMMENTS_BUTTON_NAME })
      ).toBeInTheDocument();
    });

    selectRenderedText(document.body, "shared session detail screen");
    fireEvent.mouseUp(document.querySelector(".st") as HTMLElement);
    await user.click(
      screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    );
    await user.type(
      screen.getByPlaceholderText(INLINE_TRACE_COMMENT_PLACEHOLDER),
      "First note on an empty session"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));

    // Anchoring the first comment reveals the full rail (existing reveal wiring).
    expect(document.querySelector(".sd3-cmts")).toBeInTheDocument();
    expect(
      screen.getByText("First note on an empty session")
    ).toBeInTheDocument();
  });

  it("keeps the rail open for a session that already has comments", async () => {
    // A persisted comment on the target: the rail must open, not fold.
    seedSessionTraceComment(populatedAgentSessionDetailFixture.id);
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          commentsRailOpen
          isLoading={false}
          session={populatedAgentSessionDetailFixture}
        />
      )
    );

    await waitFor(() => {
      expect(document.querySelector(".sd3-cmts")).toBeInTheDocument();
    });
    // The seeded comment renders in the open rail (proving it opened because
    // comments exist, not merely during loading).
    expect(await screen.findByText("Seeded trace comment")).toBeInTheDocument();
    // The collapse control is present (the reader can still collapse manually),
    // but the empty default never engaged.
    expect(
      screen.getByRole("button", { name: COLLAPSE_COMMENTS_BUTTON_NAME })
    ).toBeInTheDocument();
  });

  it("re-opens the empty rail from the collapsed handle without a comment", async () => {
    const user = userEvent.setup();
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          commentsRailOpen
          isLoading={false}
          session={populatedAgentSessionDetailFixture}
        />
      )
    );

    const showButton = await screen.findByRole("button", {
      name: SHOW_COMMENTS_BUTTON_NAME,
    });
    await user.click(showButton);

    // The handle forces the full (empty) panel open via the reveal override —
    // even though the empty default and the saved preference both say collapsed.
    expect(document.querySelector(".sd3-cmts")).toBeInTheDocument();
    expect(screen.getByText("No trace comments yet")).toBeInTheDocument();
  });
});
