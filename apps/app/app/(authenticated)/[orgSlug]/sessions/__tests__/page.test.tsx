import { DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY } from "@repo/api/src/types/agent-session";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSessionsPageQuery,
  mockSessionsPageEmptyState,
  mockSessionsPageLoadingState,
  navigationReplaceMock,
  orgDefaultSessionsPageHookArgs,
  resetSessionsPageTestState,
  selectedUserSessionsPageHookArgs,
  sessionLinkName,
  sessionsEmptyDescription,
  sessionsEmptyTitle,
  setSelectedSessionUser,
  setSessionsPageQuery,
  setSessionsTotal,
  useAgentSessionsMock,
} from "../../../__tests__/sessions-page-test-helpers";
import SessionsPage from "../page";

const STATUS_BUTTON_NAME_REGEX = /status/i;

describe("org sessions page wrapper", () => {
  beforeEach(() => {
    resetSessionsPageTestState("organization");
  });

  it("keeps flag placement, default filters, page size, and org session hrefs", () => {
    render(<SessionsPage />);

    const sessionLink = screen.getByRole("link", { name: sessionLinkName });

    expect(sessionLink).toHaveAttribute("href", "/acme/sessions/session-1");
    expect(sessionLink.closest("[data-feature-flag]")).toHaveAttribute(
      "data-feature-flag",
      DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY
    );
    expect(useAgentSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining(orgDefaultSessionsPageHookArgs)
    );
  });

  it("preserves selected-user query filtering", () => {
    setSelectedSessionUser("user-123");

    render(<SessionsPage />);

    expect(screen.getByText("User filtered")).toBeInTheDocument();
    expect(useAgentSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining(selectedUserSessionsPageHookArgs)
    );
  });

  it("uses the page query for API offset and writes pagination through the route", async () => {
    const user = userEvent.setup();
    setSessionsPageQuery("2");
    setSelectedSessionUser("user-123");
    setSessionsTotal(50);

    render(<SessionsPage />);

    expect(useAgentSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        offset: 25,
        userId: "user-123",
      })
    );

    await user.click(
      within(screen.getByRole("navigation", { name: "pagination" })).getByText(
        "1"
      )
    );

    expect(navigationReplaceMock).toHaveBeenCalledWith(
      "/acme/sessions?userId=user-123",
      { scroll: false }
    );
  });

  it("repairs a stale page query after the response proves it is out of range", async () => {
    setSessionsPageQuery("2");
    setSessionsTotal(10);

    render(<SessionsPage />);

    expect(useAgentSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 25 })
    );
    await waitFor(() =>
      expect(navigationReplaceMock).toHaveBeenCalledWith("/acme/sessions", {
        scroll: false,
      })
    );
    expect(useAgentSessionsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 0 })
    );
  });

  it("prevents a stale page offset after sorting while search params still lag", async () => {
    const user = userEvent.setup();
    setSessionsPageQuery("2");
    setSessionsTotal(50);

    const { rerender } = render(<SessionsPage />);
    expect(useAgentSessionsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 25 })
    );

    await user.click(
      screen.getByRole("button", { name: STATUS_BUTTON_NAME_REGEX })
    );

    expect(navigationReplaceMock).toHaveBeenCalledWith("/acme/sessions", {
      scroll: false,
    });
    expect(useAgentSessionsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 0 })
    );

    clearSessionsPageQuery();
    rerender(<SessionsPage />);

    expect(useAgentSessionsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 0 })
    );
  });

  it("prevents a stale page offset after facet filters change while search params still lag", async () => {
    const user = userEvent.setup();
    setSessionsPageQuery("2");
    setSessionsTotal(50);

    render(<SessionsPage />);
    expect(useAgentSessionsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 25 })
    );

    await user.click(screen.getByRole("button", { name: "Filter owner Ada" }));

    expect(navigationReplaceMock).toHaveBeenCalledWith("/acme/sessions", {
      scroll: false,
    });
    await waitFor(() =>
      expect(useAgentSessionsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          offset: 0,
          userIds: ["user-e2e"],
        })
      )
    );
  });

  it("passes loading state into the real shared list renderer", () => {
    mockSessionsPageLoadingState();

    render(<SessionsPage />);

    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("passes empty results into the real shared list renderer", () => {
    mockSessionsPageEmptyState("organization");

    render(<SessionsPage />);

    expect(screen.getByText(sessionsEmptyTitle)).toBeInTheDocument();
    expect(screen.getByText(sessionsEmptyDescription)).toBeInTheDocument();
  });
});
