import {
  ERRORED_NAVIGATION_VIEW_MODEL,
  NavigationActorStanding,
  NavigationDestinationStatus,
  NavigationProjectionStatus,
  type NavigationViewModel,
  PENDING_NAVIGATION_VIEW_MODEL,
} from "@repo/api/src/types/navigation-view-model";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../shared/api/api-error";
import { FOCUS_REFETCH_ERROR_COOLDOWN_MS } from "../../../../shared/query/query-client";
import {
  buildNavigationSectionModel,
  type NavigationSectionInput,
} from "../../lib/navigation-section-model";

const mockApiClient = { get: vi.fn() };
const mockAuth: { orgId: string | null; userId: string | null } = {
  orgId: "org_a",
  userId: "user_a",
};

vi.mock("../../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

vi.mock("../../../../shared/auth/use-auth-snapshot", () => ({
  useAuthSnapshot: () => mockAuth,
}));

import { useNavigationViewModel } from "../use-navigation-view-model";

beforeEach(() => {
  mockApiClient.get.mockReset();
  mockAuth.orgId = "org_a";
  mockAuth.userId = "user_a";
});

describe("useNavigationViewModel", () => {
  it("asks for each destination as a repeated parameter", async () => {
    mockApiClient.get.mockResolvedValue(readyViewModel());

    renderViewModelHook(["sessions", "dashboard"]);

    await waitFor(() => expect(mockApiClient.get).toHaveBeenCalledTimes(1));
    expect(mockApiClient.get).toHaveBeenCalledWith(
      "/navigation/view-model?destinations=dashboard&destinations=sessions"
    );
  });

  it("reports the pending view model while the first read is in flight", () => {
    mockApiClient.get.mockReturnValue(new Promise(() => undefined));

    const { result } = renderViewModelHook();

    expect(result.current).toBe(PENDING_NAVIGATION_VIEW_MODEL);
  });

  it("issues no read while held, then exactly one once released", async () => {
    mockApiClient.get.mockResolvedValue(readyViewModel());
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { rerender, result } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useNavigationViewModel(["sessions"], { enabled }),
      { initialProps: { enabled: false }, wrapper }
    );

    // Held means PENDING, not an empty projection: a host whose gates have not
    // resolved knows nothing yet, and a read issued for that provisional answer
    // is keyed on it and never rendered from.
    expect(result.current).toBe(PENDING_NAVIGATION_VIEW_MODEL);
    expect(mockApiClient.get).not.toHaveBeenCalled();

    rerender({ enabled: true });

    await waitFor(() => expect(result.current).toEqual(readyViewModel()));
    expect(mockApiClient.get).toHaveBeenCalledTimes(1);
  });

  it("reports the errored view model when the first read fails", async () => {
    mockApiClient.get.mockRejectedValue(new Error("503"));

    const { result } = renderViewModelHook();

    await waitFor(() =>
      expect(result.current).toBe(ERRORED_NAVIGATION_VIEW_MODEL)
    );
  });

  it("keeps the last projection when a later refetch fails", async () => {
    mockApiClient.get.mockResolvedValueOnce(readyViewModel());
    const { queryClient, result } = renderViewModelHook();
    await waitFor(() => expect(result.current).toEqual(readyViewModel()));

    mockApiClient.get.mockRejectedValueOnce(new Error("503"));
    await queryClient.refetchQueries();

    await waitFor(() =>
      expect(queryClient.getQueryCache().getAll()[0]?.state.status).toBe(
        "error"
      )
    );
    expect(result.current).toEqual(readyViewModel());
  });

  it.each([
    ["organization", () => Object.assign(mockAuth, { orgId: "org_b" })],
    ["user", () => Object.assign(mockAuth, { userId: "user_b" })],
  ])(
    "does not serve one %s's projection after a switch",
    async (_label, switchActor) => {
      mockApiClient.get.mockResolvedValueOnce(readyViewModel());
      const { rerender, result } = renderViewModelHook();
      await waitFor(() => expect(result.current).toEqual(readyViewModel()));

      mockApiClient.get.mockReturnValue(new Promise(() => undefined));
      switchActor();
      rerender();

      expect(result.current).toBe(PENDING_NAVIGATION_VIEW_MODEL);
    }
  );

  it("folds a projection status this build does not know to rows that are not links", async () => {
    mockApiClient.get.mockResolvedValue(
      JSON.parse(
        '{"projectionStatus":"partial","standing":"member","organizationId":"org_a","destinations":{"sessions":{"status":"ready"}}}'
      )
    );

    const { result } = renderViewModelHook();

    await waitFor(() =>
      expect(result.current.projectionStatus).toBe("partial")
    );
    expect(rowsFor(result.current)).toEqual([
      ["sessions", NavigationDestinationStatus.CapabilityError, false],
    ]);
  });

  it("folds a 404 from an API that predates the route to rows that are not links", async () => {
    mockApiClient.get.mockRejectedValue(new ApiError("Not found", 404));

    const { result } = renderViewModelHook();

    await waitFor(() =>
      expect(result.current).toBe(ERRORED_NAVIGATION_VIEW_MODEL)
    );
    expect(rowsFor(result.current)).toEqual([
      ["sessions", NavigationDestinationStatus.CapabilityError, false],
    ]);
  });

  it("treats a body without a projection's structure as a failed read", async () => {
    mockApiClient.get.mockResolvedValue({ success: true });

    const { result } = renderViewModelHook();

    await waitFor(() =>
      expect(result.current).toBe(ERRORED_NAVIGATION_VIEW_MODEL)
    );
    expect(rowsFor(result.current)).toEqual([
      ["sessions", NavigationDestinationStatus.CapabilityError, false],
    ]);
  });

  it("treats a destination whose count is null as a failed read", async () => {
    mockApiClient.get.mockResolvedValue(
      JSON.parse(
        '{"projectionStatus":"ready","standing":"member","organizationId":"org_a","destinations":{"sessions":{"status":"ready","count":null}}}'
      )
    );

    const { result } = renderViewModelHook();

    await waitFor(() =>
      expect(result.current).toBe(ERRORED_NAVIGATION_VIEW_MODEL)
    );
    expect(rowsFor(result.current)).toEqual([
      ["sessions", NavigationDestinationStatus.CapabilityError, false],
    ]);
  });
});

describe("useNavigationViewModel — focus after a failed read", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds a failed read on focus until the shared error cooldown has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    mockApiClient.get.mockRejectedValue(new ApiError("Not found", 404));
    const { queryClient, result } = renderViewModelHook();
    await waitFor(() =>
      expect(result.current).toBe(ERRORED_NAVIGATION_VIEW_MODEL)
    );

    // The cache's focus handler, called directly: the focus manager reaches it
    // only after an awaited step, while a refetch it allows starts synchronously,
    // so the call count is settled on the very next line.
    queryClient.getQueryCache().onFocus();
    expect(mockApiClient.get).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + FOCUS_REFETCH_ERROR_COOLDOWN_MS);
    queryClient.getQueryCache().onFocus();
    expect(mockApiClient.get).toHaveBeenCalledTimes(2);
  });
});

const SESSIONS_ONLY: readonly NavigationSectionInput[] = [
  {
    id: "artifacts",
    label: "Artifacts",
    collapsible: true,
    defaultOpen: true,
    destinations: [
      {
        id: "sessions",
        label: "Sessions",
        href: "/sessions",
        offeredOnHost: true,
      },
    ],
  },
];

function readyViewModel(): NavigationViewModel {
  return {
    projectionStatus: NavigationProjectionStatus.Ready,
    standing: NavigationActorStanding.Member,
    organizationId: "org_a",
    destinations: { sessions: { status: NavigationDestinationStatus.Ready } },
  };
}

function renderViewModelHook(destinationIds: readonly string[] = ["sessions"]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return {
    queryClient,
    ...renderHook(() => useNavigationViewModel(destinationIds), { wrapper }),
  };
}

function rowsFor(viewModel: NavigationViewModel) {
  return buildNavigationSectionModel(SESSIONS_ONLY, viewModel).flatMap(
    (section) =>
      section.entries.map((entry) => [entry.id, entry.status, entry.navigable])
  );
}
