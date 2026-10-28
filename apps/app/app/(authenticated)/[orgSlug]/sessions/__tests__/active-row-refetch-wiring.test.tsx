import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { SESSIONS_ACTIVE_ROW_REFETCH_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enableSessionsPageFeatureFlag,
  resetSessionsPageTestState,
  useAgentSessionsMock,
  useAgentSessionUsageMock,
} from "../../../__tests__/sessions-page-test-helpers";
import SessionsPage from "../page";
import { SessionsPageTestProviders } from "./sessions-page-test-providers";

/**
 * FEA-4203 — the WEB page's own refetch wiring.
 *
 * `sessions-active-refetch.test.ts` proves the gate in isolation, and it stays
 * green if this page never calls it: deleting the `refetchInterval` option from
 * the `useAgentSessions` call would leave the list with no poll at all and no
 * suite would notice. So this mounts the real `SessionsPage`, takes the resolver
 * the page actually handed the query, and runs it against both a running-row
 * response and a terminal-row one.
 *
 * Reading the resolver rather than waiting for a request is deliberate: what is
 * under test is the DECISION the page installs, and asserting it directly needs
 * no wall clock (see the repo's no-timing-assertions rule).
 */

vi.mock("@repo/app/shared/auth/use-auth-snapshot", () => {
  const snapshot = {
    getToken: () => Promise.resolve(null),
    isLoaded: true,
    orgId: "org_test",
    userId: "user_test",
  };
  return {
    useAuthSnapshot: () => snapshot,
    useOptionalAuthSnapshot: () => snapshot,
  };
});

const POLL_MS = 30_000;
const SUMMARY_POLL_MS = 120_000;
const BACKOFF_MS = 300_000;

function runningRow() {
  return createAgentSessionListItemFixture({
    awaitingInputSince: null,
    endedAt: null,
    id: "running",
    lastActivityAt: new Date(),
    startedAt: new Date(),
    status: SESSION_STATUS.ACTIVE,
  });
}

function terminalRow() {
  return createAgentSessionListItemFixture({
    awaitingInputSince: null,
    endedAt: new Date("2026-08-24T10:00:00.000Z"),
    id: "terminal",
    lastActivityAt: new Date("2026-08-24T10:00:00.000Z"),
    startedAt: new Date("2026-08-24T09:00:00.000Z"),
    status: SESSION_STATUS.INACTIVE,
  });
}

/** The `{ state: { data, status } }` shape TanStack hands a `refetchInterval` resolver. */
function queryHolding(
  items: ReturnType<typeof runningRow>[],
  status: "error" | "pending" | "success" = "success"
) {
  return { state: { data: { items, total: items.length }, status } };
}

/**
 * The `refetchInterval` the page installed on its list read, or `undefined` when
 * it installed none — which is what a reverted wiring looks like.
 */
function installedRefetchInterval() {
  const calls = useAgentSessionsMock.mock.calls;
  const options = calls.at(-1)?.[1];
  return options?.refetchInterval;
}

describe("Sessions page — active-row refetch wiring (FEA-4203)", () => {
  beforeEach(() => {
    resetSessionsPageTestState("organization");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("polls only while a running row is on the page, with the flag on", () => {
    enableSessionsPageFeatureFlag(SESSIONS_ACTIVE_ROW_REFETCH_FEATURE_FLAG_KEY);
    render(<SessionsPage />, { wrapper: SessionsPageTestProviders });

    const refetchInterval = installedRefetchInterval();
    if (typeof refetchInterval !== "function") {
      throw new Error("the page installed no refetchInterval resolver");
    }

    expect(refetchInterval(queryHolding([runningRow()]))).toBe(POLL_MS);
    // Same resolver, same mount — only the rows differ, so an implementation
    // that polls regardless of what is on screen fails here.
    expect(refetchInterval(queryHolding([terminalRow()]))).toBe(false);
  });

  it("never polls with the flag off — its shipped default", () => {
    render(<SessionsPage />, { wrapper: SessionsPageTestProviders });

    const refetchInterval = installedRefetchInterval();
    if (typeof refetchInterval !== "function") {
      throw new Error("the page installed no refetchInterval resolver");
    }

    expect(refetchInterval(queryHolding([runningRow()]))).toBe(false);
  });

  // ISS-12286 — operator ruling (Marisol Ashgrove, 2026-10-08, PRD-792 open
  // question 1, updated the same day): the summary keeps the running-row gate
  // but polls every 2 minutes rather than the list's 30s.
  it("polls the summary read on the 2-minute fallback while a row is running", () => {
    enableSessionsPageFeatureFlag(SESSIONS_ACTIVE_ROW_REFETCH_FEATURE_FLAG_KEY);
    useAgentSessionsMock.mockReturnValue({
      data: { items: [runningRow()], total: 1 },
      isLoading: false,
      isLoadingError: false,
      isPending: false,
    });
    render(<SessionsPage />, { wrapper: SessionsPageTestProviders });

    const usageOptions = useAgentSessionUsageMock.mock.calls.at(-1)?.[1];
    // A RESOLVER now, not a bare number: the summary decides from its OWN
    // `status` so it can back off on its own failure (the list is an
    // independent failure domain).
    const usageRefetchInterval = usageOptions?.refetchInterval;
    if (typeof usageRefetchInterval !== "function") {
      throw new Error("the page installed no summary refetchInterval resolver");
    }
    expect(usageRefetchInterval(queryHolding([]))).toBe(SUMMARY_POLL_MS);
    expect(usageOptions?.refetchIntervalInBackground).toBe(false);
  });

  // ISS-12286 done-when: mount + 2 minutes with one Active row reads the
  // summary at most twice (mount, then the fallback). Drives the resolver the
  // page installed through a real query on a fake clock; the pre-fix 30s
  // cadence read it five times.
  it("reads the summary at most twice in the first two minutes with one running row", async () => {
    enableSessionsPageFeatureFlag(SESSIONS_ACTIVE_ROW_REFETCH_FEATURE_FLAG_KEY);
    useAgentSessionsMock.mockReturnValue({
      data: { items: [runningRow()], total: 1 },
      isLoading: false,
      isLoadingError: false,
      isPending: false,
    });
    render(<SessionsPage />, { wrapper: SessionsPageTestProviders });
    const usageRefetchInterval =
      useAgentSessionUsageMock.mock.calls.at(-1)?.[1]?.refetchInterval;
    if (typeof usageRefetchInterval !== "function") {
      throw new Error("the page installed no summary refetchInterval resolver");
    }

    vi.useFakeTimers();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const queryFn = vi.fn(() => Promise.resolve({ total: 1 }));
    const observer = new QueryObserver(client, {
      queryFn,
      queryKey: ["iss-12286-summary-cadence"],
      refetchInterval: usageRefetchInterval,
      refetchIntervalInBackground: true,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    unsubscribe();
    client.clear();

    expect(queryFn.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(queryFn.mock.calls.length).toBeLessThanOrEqual(2);
  });

  // The summary's own failure must not ride the healthy list's cadence. The
  // rows come from the LIST (the usage payload carries none) while the status
  // comes from the SUMMARY, so this fails if the page ever passes the list's
  // status here — the two are independent failure domains (FEA-4177).
  it("backs the summary cadence off when the summary read is failing", () => {
    enableSessionsPageFeatureFlag(SESSIONS_ACTIVE_ROW_REFETCH_FEATURE_FLAG_KEY);
    useAgentSessionsMock.mockReturnValue({
      data: { items: [runningRow()], total: 1 },
      isLoading: false,
      isLoadingError: false,
      isPending: false,
    });
    render(<SessionsPage />, { wrapper: SessionsPageTestProviders });

    const usageRefetchInterval =
      useAgentSessionUsageMock.mock.calls.at(-1)?.[1]?.refetchInterval;
    if (typeof usageRefetchInterval !== "function") {
      throw new Error("the page installed no summary refetchInterval resolver");
    }
    expect(usageRefetchInterval(queryHolding([], "error"))).toBe(BACKOFF_MS);
    expect(usageRefetchInterval(queryHolding([], "success"))).toBe(
      SUMMARY_POLL_MS
    );
  });

  // The page must hand the gate the query's OWN status, not just its rows.
  // Dropping `status: query.state.status` from the page leaves this resolver
  // reading `undefined` and returning the healthy 30s on a failing read — the
  // infinite-retry loop packages/app/AGENTS.md forbids — and only this case sees it.
  it("backs the list cadence off when the list read is failing", () => {
    enableSessionsPageFeatureFlag(SESSIONS_ACTIVE_ROW_REFETCH_FEATURE_FLAG_KEY);
    render(<SessionsPage />, { wrapper: SessionsPageTestProviders });

    const refetchInterval = installedRefetchInterval();
    if (typeof refetchInterval !== "function") {
      throw new Error("the page installed no refetchInterval resolver");
    }

    expect(refetchInterval(queryHolding([runningRow()], "error"))).toBe(
      BACKOFF_MS
    );
    // Same resolver, same rows, healthy read — so this pins the pass-through
    // rather than a resolver that returns the backoff for everything.
    expect(refetchInterval(queryHolding([runningRow()], "success"))).toBe(
      POLL_MS
    );
  });

  // A backgrounded tab has nobody watching, so the poll pauses with it. This is
  // the option a "make it feel live" change is most likely to flip.
  it("does not poll while the window is in the background", () => {
    render(<SessionsPage />, { wrapper: SessionsPageTestProviders });

    const options = useAgentSessionsMock.mock.calls.at(-1)?.[1];
    expect(options?.refetchIntervalInBackground).toBe(false);
  });
});
