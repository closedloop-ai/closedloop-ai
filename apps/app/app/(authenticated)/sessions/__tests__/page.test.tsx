import { DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY } from "@repo/api/src/types/agent-session";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSessionsPageQuery,
  defaultSessionsPageHookArgs,
  lastSessionsTableCallArgs,
  mockSessionsPageEmptyState,
  mockSessionsPageLoadingState,
  navigationReplaceMock,
  resetSessionsPageTestState,
  selectedUserSessionsPageHookArgs,
  sessionHistoryHeading,
  sessionLinkName,
  sessionsEmptyDescription,
  sessionsEmptyTitle,
  sessionsPageCount,
  setSelectedSessionUser,
  setSessionsPageQuery,
  setSessionsTotal,
  useAgentSessionsMock,
} from "../../__tests__/sessions-page-test-helpers";
import SessionsPage from "../page";

describe("sessions page wrapper", () => {
  beforeEach(() => {
    resetSessionsPageTestState("self");
  });

  it("keeps flag placement, default filters, page size, and non-org session hrefs", () => {
    render(<SessionsPage />);

    const sessionLink = screen.getByRole("link", { name: sessionLinkName });

    expect(sessionLink).toHaveAttribute("href", "/sessions/session-1");
    expect(screen.getByText(sessionHistoryHeading)).toBeInTheDocument();
    expect(screen.getByText(sessionsPageCount)).toBeInTheDocument();
    expect(sessionLink.closest("[data-feature-flag]")).toHaveAttribute(
      "data-feature-flag",
      DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY
    );
    expect(useAgentSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining(defaultSessionsPageHookArgs)
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

  it("uses the page query for API offset and writes previous/next pages through the route", async () => {
    const user = userEvent.setup();
    setSessionsPageQuery("2");
    setSelectedSessionUser("user-123");
    setSessionsTotal(75);

    render(<SessionsPage />);

    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
    expect(useAgentSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        offset: 25,
        userId: "user-123",
      })
    );

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(navigationReplaceMock).toHaveBeenLastCalledWith(
      "/sessions?page=3&userId=user-123",
      { scroll: false }
    );

    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(navigationReplaceMock).toHaveBeenLastCalledWith(
      "/sessions?userId=user-123",
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
      expect(navigationReplaceMock).toHaveBeenCalledWith("/sessions", {
        scroll: false,
      })
    );
    expect(lastSessionsTableCallArgs()).toEqual(
      expect.objectContaining({ offset: 0 })
    );
  });

  it("prevents a stale page offset after status changes while search params still lag", async () => {
    const user = userEvent.setup();
    setSessionsPageQuery("2");
    setSessionsTotal(50);

    const { rerender } = render(<SessionsPage />);
    expect(lastSessionsTableCallArgs()).toEqual(
      expect.objectContaining({ offset: 25 })
    );

    await user.selectOptions(
      screen.getAllByRole("combobox")[2] as HTMLElement,
      "error"
    );

    expect(navigationReplaceMock).toHaveBeenCalledWith("/sessions", {
      scroll: false,
    });
    expect(lastSessionsTableCallArgs()).toEqual(
      expect.objectContaining({ offset: 0 })
    );

    clearSessionsPageQuery();
    rerender(<SessionsPage />);

    expect(lastSessionsTableCallArgs()).toEqual(
      expect.objectContaining({ offset: 0 })
    );
  });

  it("prevents a stale page offset after date range changes while search params still lag", async () => {
    const user = userEvent.setup();
    setSessionsPageQuery("2");
    setSessionsTotal(50);

    render(<SessionsPage />);
    expect(lastSessionsTableCallArgs()).toEqual(
      expect.objectContaining({ offset: 25 })
    );

    await user.selectOptions(
      screen.getAllByRole("combobox")[0] as HTMLElement,
      "7d"
    );

    expect(navigationReplaceMock).toHaveBeenCalledWith("/sessions", {
      scroll: false,
    });
    await waitFor(() =>
      expect(lastSessionsTableCallArgs()).toEqual(
        expect.objectContaining({ offset: 0 })
      )
    );
  });

  it("prevents a stale page offset after harness changes while search params still lag", async () => {
    const user = userEvent.setup();
    setSessionsPageQuery("2");
    setSessionsTotal(50);

    render(<SessionsPage />);
    expect(lastSessionsTableCallArgs()).toEqual(
      expect.objectContaining({ offset: 25 })
    );

    await user.selectOptions(
      screen.getAllByRole("combobox")[1] as HTMLElement,
      "codex"
    );

    expect(navigationReplaceMock).toHaveBeenCalledWith("/sessions", {
      scroll: false,
    });
    await waitFor(() =>
      expect(lastSessionsTableCallArgs()).toEqual(
        expect.objectContaining({ harness: "codex", offset: 0 })
      )
    );
  });

  it("passes loading state into the real shared list renderer", () => {
    mockSessionsPageLoadingState();

    render(<SessionsPage />);

    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("passes empty results into the real shared list renderer", () => {
    mockSessionsPageEmptyState("self");

    render(<SessionsPage />);

    expect(screen.getByText(sessionsEmptyTitle)).toBeInTheDocument();
    expect(screen.getByText(sessionsEmptyDescription)).toBeInTheDocument();
  });
});
