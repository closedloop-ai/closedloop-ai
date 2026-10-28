import type { AgentSessionListResponse } from "@repo/api/src/types/agent-session";
import { ReadInitiator } from "@repo/api/src/types/read-initiator";
import { queryReadInitiator } from "@repo/app/agents/hooks/read-initiator";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopInsightsBoundedView } from "../desktop-insights-bounded-view";

/**
 * ISS-11412: Desktop Insights pages through the v2 `TablePagination`. v2 stays
 * mounted on a single page by design (ISS-11412 Decision 3), so a settled
 * one-page list now shows the pager with both boundaries locked. Before any
 * data exists the view's `total` is only its 0 default, and the pager stays out
 * exactly as it did on v1, which rendered nothing for that one-page fallback.
 */

type SessionsQueryState = {
  data: AgentSessionListResponse | undefined;
  isError: boolean;
  isFetching: boolean;
  isLoading: boolean;
  refetch: () => Promise<unknown>;
};

const { useAgentSessionsMock } = vi.hoisted(() => ({
  useAgentSessionsMock: vi.fn<(filters: unknown) => SessionsQueryState>(),
}));

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessions: useAgentSessionsMock,
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => false,
}));

// The rows are not under test here; the table's own suites own them.
vi.mock("@repo/app/agents/components/sessions/synced-sessions-table", () => ({
  SyncedSessionsTable: () => null,
}));

vi.mock("@repo/app/insights/hooks/use-session-mesh-insights", () => ({
  useSessionMeshInsights: () => ({
    data: undefined,
    isError: false,
    isLoading: false,
  }),
}));

const PREVIOUS = "Go to previous page";
const NEXT = "Go to next page";
const PAGE_SIZE = 25;

function sessionsState(
  overrides: Partial<SessionsQueryState>
): SessionsQueryState {
  return {
    data: undefined,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: () => Promise.resolve(undefined),
    ...overrides,
  };
}

/** A settled read reporting `total` sessions (rows are mocked away). */
function settled(total: number): AgentSessionListResponse {
  return { items: [], total } as unknown as AgentSessionListResponse;
}

function pager(): HTMLElement | null {
  return screen.queryByRole("navigation", { name: "pagination" });
}

afterEach(() => {
  cleanup();
  useAgentSessionsMock.mockReset();
});

describe("DesktopInsightsBoundedView pager", () => {
  it("renders no pager while the first read is loading", () => {
    useAgentSessionsMock.mockReturnValue(sessionsState({ isLoading: true }));
    render(<DesktopInsightsBoundedView />);

    expect(screen.getByText("Loading recent sessions...").textContent).toBe(
      "Loading recent sessions..."
    );
    expect(pager()).toBeNull();
  });

  it("renders no pager when the read failed with nothing retained", () => {
    useAgentSessionsMock.mockReturnValue(sessionsState({ isError: true }));
    render(<DesktopInsightsBoundedView />);

    expect(
      screen.getByText("Recent sessions are temporarily unavailable.")
        .textContent
    ).toBe("Recent sessions are temporarily unavailable.");
    expect(pager()).toBeNull();
  });

  it("keeps the multi-page pager when a refresh fails over retained data", () => {
    useAgentSessionsMock.mockReturnValue(
      sessionsState({ data: settled(PAGE_SIZE * 3), isError: true })
    );
    render(<DesktopInsightsBoundedView />);

    expect(pager()).not.toBeNull();
    expect(screen.getByLabelText(NEXT).getAttribute("aria-disabled")).toBe(
      "false"
    );
  });

  it("shows a locked pager for a settled one-page list", () => {
    useAgentSessionsMock.mockReturnValue(sessionsState({ data: settled(3) }));
    render(<DesktopInsightsBoundedView />);

    expect(pager()).not.toBeNull();
    expect(screen.getByLabelText(PREVIOUS).getAttribute("aria-disabled")).toBe(
      "true"
    );
    expect(screen.getByLabelText(NEXT).getAttribute("aria-disabled")).toBe(
      "true"
    );
  });

  it("shows a locked pager for a settled empty list", () => {
    useAgentSessionsMock.mockReturnValue(sessionsState({ data: settled(0) }));
    render(<DesktopInsightsBoundedView />);

    expect(pager()).not.toBeNull();
    expect(screen.getByLabelText(PREVIOUS).getAttribute("aria-disabled")).toBe(
      "true"
    );
    expect(screen.getByLabelText(NEXT).getAttribute("aria-disabled")).toBe(
      "true"
    );
  });

  it("requests the next page when Next is pressed", () => {
    useAgentSessionsMock.mockReturnValue(
      sessionsState({ data: settled(PAGE_SIZE * 2 + 5) })
    );
    render(<DesktopInsightsBoundedView />);

    expect(useAgentSessionsMock).toHaveBeenLastCalledWith({
      limit: PAGE_SIZE,
      offset: 0,
    });
    fireEvent.click(screen.getByLabelText(NEXT));
    expect(useAgentSessionsMock).toHaveBeenLastCalledWith({
      limit: PAGE_SIZE,
      offset: PAGE_SIZE,
    });
  });
});

describe("DesktopInsightsBoundedView Refresh (ISS-12039)", () => {
  it("issues the Refresh read as user-initiated over a settled key", () => {
    const client = new QueryClient();
    client.setQueryData(["s"], 1);
    const settledKey = { client, queryKey: ["s"] };
    let refreshInitiator: string | undefined;
    useAgentSessionsMock.mockReturnValue(
      sessionsState({
        data: settled(1),
        refetch: () => {
          refreshInitiator = queryReadInitiator(settledKey);
          return Promise.resolve(undefined);
        },
      })
    );
    render(<DesktopInsightsBoundedView />);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(refreshInitiator).toBe(ReadInitiator.User);
    expect(queryReadInitiator(settledKey)).toBe(ReadInitiator.Background);
  });
});
