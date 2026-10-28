import {
  BROWSER_SESSION_PAGE_LIMIT_MAX,
  type BrowserSessionListResponse,
} from "@repo/api/src/types/browser-session";
import { SettingsPanelIntent } from "@repo/api/src/types/settings-panel";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeTargetKeys } from "../../../../../compute/hooks/compute-target-query-keys";
import { COMPUTE_TARGETS_POLL_INTERVAL_MS } from "../../../../../compute/hooks/compute-target-query-options";
import { ApiError } from "../../../../../shared/api/api-error";
import { makeQueryClient } from "../../../../../shared/query/query-client";
import {
  buildBrowserSessionFixture,
  buildBrowserSessionListFixture,
  buildComputeTargetFixture,
} from "../../../test-fixtures/device-panel-fixtures";
import { ConnectedDevicesPanel } from "../connected-devices-panel";

const mockApiClient = { delete: vi.fn(), get: vi.fn() };

vi.mock("../../../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const BROWSER_SESSIONS_PATH = "/settings/browser-sessions";
const COMPUTE_TARGETS_PATH = "/compute-targets";
const SESSIONS_GROUP = "Browser sessions";
const DESKTOPS_GROUP = "Registered desktops";
const NO_SESSIONS_TITLE = "No other browser sessions";
const RE_TRUNCATED_COUNT = /Showing 1 of 9 active sessions/;
const RE_UNKNOWN_EXTENT = /We couldn't confirm whether that is all of them/;
const RE_NO_CURRENT_ROW = /none is marked as current/;

type ReadStub = () => Promise<unknown>;

function stubReads(options: { sessions?: ReadStub; targets?: ReadStub }): void {
  mockApiClient.get.mockImplementation((path: string) => {
    if (path.startsWith(BROWSER_SESSIONS_PATH)) {
      return (
        options.sessions?.() ??
        Promise.resolve(buildBrowserSessionListFixture())
      );
    }
    if (path === COMPUTE_TARGETS_PATH) {
      return options.targets?.() ?? Promise.resolve([]);
    }
    return Promise.reject(new Error(`unexpected read: ${path}`));
  });
}

function renderPanel() {
  const queryClient = makeQueryClient({ gcTime: 0 });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return {
    ...render(<ConnectedDevicesPanel intent={SettingsPanelIntent.View} />, {
      wrapper,
    }),
    queryClient,
  };
}

/**
 * The read state of ONE producer's block. Scoped to its labelled region because
 * the panel renders three producers side by side and a document-wide query
 * would answer with whichever failed first.
 */
function groupState(groupName: string): string | null {
  const region = screen.getByRole("region", { name: groupName });
  return (
    region
      .querySelector("[data-settings-panel-data-state]")
      ?.getAttribute("data-settings-panel-data-state") ?? null
  );
}

function pageCompleteness(): string | null {
  return (
    document
      .querySelector("[data-browser-session-page]")
      ?.getAttribute("data-browser-session-page") ?? null
  );
}

describe("ConnectedDevicesPanel browser-session read states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("holds a still-running read as loading, not as a completed empty result", async () => {
    let settle: ((value: BrowserSessionListResponse) => void) | undefined;
    stubReads({
      sessions: () =>
        new Promise((resolve) => {
          settle = resolve as (value: BrowserSessionListResponse) => void;
        }),
    });

    renderPanel();

    await waitFor(() => expect(groupState(SESSIONS_GROUP)).toBe("loading"));
    expect(screen.queryByText(NO_SESSIONS_TITLE)).not.toBeInTheDocument();

    settle?.(buildBrowserSessionListFixture());
    expect(await screen.findByText("Chrome 148")).toBeInTheDocument();
  });

  it("NEVER renders a failed read as 'no other sessions'", async () => {
    // The load-bearing regression. The legacy surfaces leave `data` undefined on
    // a failed list read and render the empty state over it, which is a failure
    // shown as a completed answer.
    stubReads({
      sessions: () => Promise.reject(new ApiError("boom", 500)),
    });

    renderPanel();

    await waitFor(() => expect(groupState(SESSIONS_GROUP)).toBe("failed"));
    expect(screen.queryByText(NO_SESSIONS_TITLE)).not.toBeInTheDocument();
  });

  it("keeps a refusal and an undecided read apart", async () => {
    stubReads({ sessions: () => Promise.reject(new ApiError("denied", 403)) });
    const denied = renderPanel();
    await waitFor(() => expect(groupState(SESSIONS_GROUP)).toBe("forbidden"));
    denied.unmount();

    stubReads({
      sessions: () => Promise.reject(new ApiError("provider down", 503)),
    });
    renderPanel();
    await waitFor(() => expect(groupState(SESSIONS_GROUP)).toBe("unavailable"));
  });

  it("reports a genuinely session-free account as empty", async () => {
    stubReads({
      sessions: () =>
        Promise.resolve(buildBrowserSessionListFixture({ sessions: [] })),
    });

    renderPanel();

    await waitFor(() => expect(groupState(SESSIONS_GROUP)).toBe("empty"));
    expect(screen.getByText(NO_SESSIONS_TITLE)).toBeInTheDocument();
  });
});

describe("ConnectedDevicesPanel page completeness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("states a page that accounts for the whole set", async () => {
    stubReads({
      sessions: () =>
        Promise.resolve(
          buildBrowserSessionListFixture({
            sessions: [buildBrowserSessionFixture()],
            totalCount: 1,
          })
        ),
    });

    renderPanel();

    await waitFor(() => expect(pageCompleteness()).toBe("complete"));
  });

  it("states that more sessions exist than are shown", async () => {
    stubReads({
      sessions: () =>
        Promise.resolve(
          buildBrowserSessionListFixture({
            sessions: [buildBrowserSessionFixture()],
            totalCount: 9,
          })
        ),
    });

    renderPanel();

    await waitFor(() => expect(pageCompleteness()).toBe("truncated"));
    expect(screen.getByText(RE_TRUNCATED_COUNT)).toBeInTheDocument();
  });

  it("renders an unreconcilable total as Unknown, DISTINCTLY from Complete", async () => {
    // The defect the three-member shape exists to prevent. A boolean has no room
    // for "we could not tell", so it necessarily reports an unverifiable page as
    // the complete set.
    stubReads({
      sessions: () =>
        Promise.resolve(
          buildBrowserSessionListFixture({
            sessions: [buildBrowserSessionFixture()],
            totalCount: Number.MAX_SAFE_INTEGER + 2,
          })
        ),
    });

    renderPanel();

    await waitFor(() => expect(pageCompleteness()).toBe("unknown"));
    expect(pageCompleteness()).not.toBe("complete");
    expect(screen.getByText(RE_UNKNOWN_EXTENT)).toBeInTheDocument();
  });

  it("renders a null total as Unknown", async () => {
    // `totalCount` is declared `number`, but the response crosses a JSON parse
    // boundary the type does not police, so a provider silence really can
    // arrive as null on a version-skewed route.
    stubReads({
      sessions: () =>
        Promise.resolve({
          ...buildBrowserSessionListFixture(),
          totalCount: null,
        } as unknown as BrowserSessionListResponse),
    });

    renderPanel();

    await waitFor(() => expect(pageCompleteness()).toBe("unknown"));
  });
});

describe("ConnectedDevicesPanel current-session marking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks the current row and offers it no Sign out control", async () => {
    stubReads({
      sessions: () =>
        Promise.resolve(
          buildBrowserSessionListFixture({
            currentSessionKnown: true,
            sessions: [
              buildBrowserSessionFixture({
                id: "sess_current",
                isCurrentSession: true,
              }),
              buildBrowserSessionFixture({ id: "sess_other" }),
            ],
          })
        ),
    });

    renderPanel();

    const current = await screen.findByText("This session");
    expect(current).toBeInTheDocument();
    const currentRow = document.querySelector(
      '[data-browser-session-row="sess_current"]'
    );
    const otherRow = document.querySelector(
      '[data-browser-session-row="sess_other"]'
    );
    expect(
      within(currentRow as HTMLElement).queryByRole("button", {
        name: "Sign out",
      })
    ).toBeNull();
    expect(
      within(otherRow as HTMLElement).getByRole("button", { name: "Sign out" })
    ).toBeInTheDocument();
  });

  it("marks NO row current when the transport cannot identify one, and says why", async () => {
    // The Desktop transport's token is a refresh-token-family id, not a Clerk
    // session id. Without saying so the panel would imply none of these rows is
    // the one you are using.
    stubReads({
      sessions: () =>
        Promise.resolve(
          buildBrowserSessionListFixture({
            currentSessionKnown: false,
            sessions: [
              buildBrowserSessionFixture({
                id: "sess_1",
                isCurrentSession: true,
              }),
            ],
          })
        ),
    });

    renderPanel();

    await screen.findByText(RE_NO_CURRENT_ROW);
    expect(screen.queryByText("This session")).not.toBeInTheDocument();
    // ...and nothing is treated as unrevocable either.
    expect(
      screen.getByRole("button", { name: "Sign out" })
    ).toBeInTheDocument();
  });
});

describe("ConnectedDevicesPanel request shape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("puts BOTH page bounds on the wire, at the contract's maximum size", async () => {
    // Asserted on the request the mock received, not merely that it was called.
    // A page whose size the caller never stated cannot be reconciled against
    // `totalCount` afterwards, and the query key is keyed by them.
    //
    // The MAXIMUM, not the default: the panel offers no paging control, so the
    // one page it asks for is everything a user can reach, and at the default 20
    // a 21st sign-in was unreachable and unrevocable.
    //
    // No clamp is asserted because there is none: the route is the one clamping
    // authority and echoes the bounds it actually used.
    stubReads({});

    renderPanel();

    await waitFor(() =>
      expect(mockApiClient.get).toHaveBeenCalledWith(
        `${BROWSER_SESSIONS_PATH}?limit=${BROWSER_SESSION_PAGE_LIMIT_MAX}&offset=0`
      )
    );
  });

  it("reads compute targets on the shared polling contract, not the client default", async () => {
    // One query key, one freshness story. This panel renders an online/offline
    // badge; on the client's 60s default with no poll it would only move when the window regained
    // focus, so a liveness badge could sit stale beside a fresh one.
    stubReads({});

    const { queryClient } = renderPanel();

    await waitFor(() =>
      expect(
        queryClient
          .getQueryCache()
          .find({ queryKey: computeTargetKeys.list() })
          ?.observers.at(0)?.options.staleTime
      ).toBe(COMPUTE_TARGETS_POLL_INTERVAL_MS)
    );
  });
});

describe("ConnectedDevicesPanel registered desktops", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists the viewer's own targets and withholds one shared by somebody else", async () => {
    stubReads({
      targets: () =>
        Promise.resolve([
          {
            ...buildComputeTargetFixture({
              id: "mine",
              machineName: "Ada-MBP",
            }),
            createdAt: "2026-04-28T12:00:00.000Z",
            lastSeenAt: "2026-04-28T12:00:00.000Z",
            updatedAt: "2026-04-28T12:00:00.000Z",
          },
          {
            ...buildComputeTargetFixture({
              id: "theirs",
              machineName: "Grace-MBP",
              ownerName: "Grace",
            }),
            createdAt: "2026-04-28T12:00:00.000Z",
            lastSeenAt: "2026-04-28T12:00:00.000Z",
            updatedAt: "2026-04-28T12:00:00.000Z",
          },
        ]),
    });

    renderPanel();

    expect(await screen.findByText("Ada-MBP")).toBeInTheDocument();
    expect(screen.queryByText("Grace-MBP")).not.toBeInTheDocument();
  });

  it("never renders a failed target read as an empty device list", async () => {
    stubReads({ targets: () => Promise.reject(new ApiError("boom", 500)) });

    renderPanel();

    await waitFor(() => expect(groupState(DESKTOPS_GROUP)).toBe("failed"));
    expect(
      screen.queryByText("No registered desktops")
    ).not.toBeInTheDocument();
  });
});
