import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { SESSIONS_GENUINELY_EMPTY_TITLE } from "@repo/app/agents/components/sessions/sessions-empty-state";
import { MY_TASKS_RECENCY_SHOW_ALL_LABEL } from "@repo/app/my-tasks/lib/my-tasks-recency-window";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  lastSessionsTableCallArgs,
  resetSessionsPageTestState,
  sessionLinkName,
  useAgentSessionsMock,
} from "../../../__tests__/sessions-page-test-helpers";
import SessionsPage from "../page";

/**
 * ISS-11913 — the web host's half: an org whose sessions are all older than
 * the default 7d window.
 *
 * The page's list read is the module mock (windowed reads come back empty,
 * unwindowed ones hold a row), and the page's unwindowed probe runs for real
 * through the HTTP data source against a fixture `/agent-sessions` route — so
 * these cases fail if the page stops asking, asks with a window, or stops
 * handing the answer to the surface.
 */

const DATE_RANGE_EMPTY_COPY =
  "No sessions were active in the selected date range.";

const OLDER_SESSION = {
  id: "ses-older",
  name: "Older than the window",
};

/** A probe the server never answers, to observe the body before it lands. */
const PROBE_IN_FLIGHT = "in-flight";

/** @see renderSessionsListBody — the surface's quiet pending treatment. */
const SESSIONS_LIST_SKELETON_TEST_ID = "sessions-list-skeleton";

let restoreContainerWidth: (() => void) | null = null;

/** The `/agent-sessions` reads the probe issued, as the server saw them. */
let probeRequests: URLSearchParams[] = [];

beforeEach(() => {
  resetSessionsPageTestState("organization");
  localStorage.clear();
  probeRequests = [];
  restoreContainerWidth = stubContainerWidthPx(1440);
});

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

describe("Sessions page — sessions outside the window (ISS-11913)", () => {
  it("offers Show all time when every session is older than the window", async () => {
    mockWindowedListEmpty();
    renderPage(1);

    expect(await screen.findByText(DATE_RANGE_EMPTY_COPY)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show all time" })
    ).toBeInTheDocument();
    expect(screen.queryByText(SESSIONS_GENUINELY_EMPTY_TITLE)).toBeNull();
    // The probe is the whole population: one row, no window.
    expect(probeRequests).toHaveLength(1);
    expect(probeRequests[0]?.get("limit")).toBe("1");
    expect(probeRequests[0]?.has("startDate")).toBe(false);
  });

  it("keeps No sessions yet when the org has no sessions at all", async () => {
    mockWindowedListEmpty();
    renderPage(0);

    await waitFor(() => expect(probeRequests).toHaveLength(1));
    expect(await screen.findByText("No sessions yet")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: MY_TASKS_RECENCY_SHOW_ALL_LABEL })
    ).toBeNull();
  });

  it("keeps Show all time when a refetch fails over the held empty page", async () => {
    // ISS-7519: a refetch that fails over held data keeps that data's empty
    // treatment, so the probe's answer for it must stand too.
    useAgentSessionsMock.mockImplementation(() => ({
      data: { items: [], total: 0, viewerScope: "organization" },
      isError: true,
      isLoading: false,
      isLoadingError: false,
      isSuccess: false,
    }));
    renderPage(1);

    expect(await screen.findByText(DATE_RANGE_EMPTY_COPY)).toBeInTheDocument();
    expect(screen.queryByText(SESSIONS_GENUINELY_EMPTY_TITLE)).toBeNull();
  });

  it("holds the loading treatment, not No sessions yet, while the probe is out", async () => {
    mockWindowedListEmpty();
    renderPage(PROBE_IN_FLIGHT);

    await waitFor(() => expect(probeRequests).toHaveLength(1));
    expect(
      screen.getByTestId(SESSIONS_LIST_SKELETON_TEST_ID)
    ).toBeInTheDocument();
    expect(screen.queryByText(SESSIONS_GENUINELY_EMPTY_TITLE)).toBeNull();
  });

  it("Show all time re-reads the list unwindowed and shows the sessions", async () => {
    mockWindowedListEmpty();
    renderPage(1);

    fireEvent.click(
      await screen.findByRole("button", { name: "Show all time" })
    );

    expect(
      await screen.findByRole("link", { name: sessionLinkName })
    ).toBeInTheDocument();
    expect(lastSessionsTableCallArgs()?.startDate).toBeUndefined();
  });
});

/**
 * The page's list read: empty under any window, one row unbounded. `isSuccess`
 * is set because a settled read is the only one the probe may follow.
 */
function mockWindowedListEmpty() {
  useAgentSessionsMock.mockImplementation((args: { startDate?: string }) => {
    const unwindowed = args?.startDate === undefined;
    return {
      data: unwindowed
        ? {
            items: [createAgentSessionListItemFixture()],
            total: 1,
            viewerScope: "organization",
          }
        : { items: [], total: 0, viewerScope: "organization" },
      isLoading: false,
      isSuccess: true,
    };
  });
}

function renderPage(probeTotal: number | typeof PROBE_IN_FLIGHT) {
  const probeRoute: FixtureRoute = {
    method: "GET",
    path: "/agent-sessions",
    respond: ({ searchParams }) => {
      probeRequests.push(searchParams);
      if (probeTotal === PROBE_IN_FLIGHT) {
        return new Promise(() => undefined);
      }
      return {
        items: probeTotal > 0 ? [OLDER_SESSION] : [],
        total: probeTotal,
        viewerScope: "organization",
      };
    },
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Providers({ children }: { children: ReactNode }) {
    return (
      <AppCoreStoryProviders apiRoutes={[probeRoute]}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </AppCoreStoryProviders>
    );
  }
  return render(<SessionsPage />, { wrapper: Providers });
}
