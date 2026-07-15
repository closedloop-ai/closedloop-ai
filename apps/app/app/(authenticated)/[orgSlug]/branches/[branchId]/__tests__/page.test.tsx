import { GitHubBackfillMode } from "@repo/api/src/types/github";
import { ApiError } from "@repo/app/shared/api/api-error";
import { ArtifactFlag } from "@repo/app/shared/lib/feature-flags";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React, { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BranchDetailRoutePage from "../page";

const {
  apiPostMock,
  branchDetailPageMock,
  headerMock,
  routeParamsMock,
  searchParamsMock,
  useBranchAnalyticsMock,
  useBranchDetailMock,
} = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  branchDetailPageMock: vi.fn(),
  headerMock: vi.fn(),
  routeParamsMock: vi.fn(),
  searchParamsMock: vi.fn(),
  useBranchAnalyticsMock: vi.fn(),
  useBranchDetailMock: vi.fn(),
}));

const { invalidateQueriesMock } = vi.hoisted(() => ({
  invalidateQueriesMock: vi.fn(),
}));
const REFRESH_BUTTON_NAME_PATTERN = /refresh/i;

vi.mock("@repo/app/branches/components/branch-detail-page", () => ({
  BranchDetailErrorKind: {
    NotPresent: "not-present",
    ProviderError: "provider-error",
  },
  BranchDetailPage: branchDetailPageMock,
  BranchDetailRefreshState: {
    Idle: "idle",
    Pending: "pending",
    Success: "success",
    Error: "error",
  },
  classifyBranchDetailError: (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "isNotFound" in error &&
    typeof error.isNotFound === "function" &&
    error.isNotFound()
      ? "not-present"
      : "provider-error",
}));

vi.mock("@repo/app/branches/hooks/use-branches", () => ({
  branchesKeys: {
    all: ["branches"],
    analyticsRoot: () => ["branches", "analytics"],
    commentsRoot: () => ["branches", "comments"],
    details: () => ["branches", "detail"],
    traces: () => ["branches", "trace"],
  },
  useBranchAnalytics: useBranchAnalyticsMock,
  useBranchDetail: useBranchDetailMock,
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
  };
});

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: searchParamsMock,
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ post: apiPostMock }),
}));

vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  githubKeys: { all: ["github"] },
}));

vi.mock("@repo/navigation/use-route-params", () => ({
  useRouteParams: routeParamsMock,
}));

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: headerMock,
}));

vi.mock("@/components/feature-flag-gate", () => ({
  FeatureFlagGate: ({
    children,
    flag,
  }: {
    children: ReactNode;
    flag: string;
  }) => <div data-feature-flag={flag}>{children}</div>,
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

describe("BranchDetailRoutePage", () => {
  beforeEach(() => {
    branchDetailPageMock.mockReset();
    apiPostMock.mockReset();
    headerMock.mockReset();
    routeParamsMock.mockReset();
    searchParamsMock.mockReset();
    useBranchAnalyticsMock.mockReset();
    useBranchDetailMock.mockReset();
    routeParamsMock.mockReturnValue({ branchId: "branch-1" });
    headerMock.mockImplementation(({ children }: { children: ReactNode }) =>
      React.createElement("div", { "data-testid": "header" }, children)
    );
    branchDetailPageMock.mockReturnValue(
      React.createElement("div", { "data-testid": "branch-detail" })
    );
    useBranchDetailMock.mockReturnValue({
      data: { branchName: "feature/web-branches" },
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
    });
    useBranchAnalyticsMock.mockReturnValue({ data: { activeBranchCount: {} } });
    apiPostMock.mockResolvedValue({});
    searchParamsMock.mockReturnValue(new URLSearchParams());
  });

  it("routes the web detail page through the Branches flag and shared body", () => {
    render(<BranchDetailRoutePage />);

    expect(
      screen.getByTestId("branch-detail").closest("[data-feature-flag]")
    ).toHaveAttribute("data-feature-flag", ArtifactFlag.Branches);
    expect(useBranchDetailMock).toHaveBeenCalledWith(
      "branch-1",
      expect.objectContaining({
        refetchOnWindowFocus: true,
        staleTime: 30_000,
      }),
      { cacheScope: "org:acme" }
    );
    expect(useBranchAnalyticsMock).toHaveBeenCalledTimes(1);
    expect(useBranchAnalyticsMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        refetchOnWindowFocus: true,
        staleTime: 30_000,
      }),
      { cacheScope: "org:acme" }
    );
    expect(headerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        breadcrumbs: [
          { label: "Branches", href: "/acme/branches" },
          { label: "feature/web-branches" },
        ],
        children: expect.any(Object),
      }),
      undefined
    );
    expect(branchDetailPageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        backHref: "/acme/branches",
        branchId: "branch-1",
        allowLiveOverlays: false,
        errorKind: "provider-error",
        isError: false,
        isLoading: false,
        queryIdentity: { cacheScope: "org:acme" },
        refreshState: "idle",
      }),
      undefined
    );
  });

  it("coerces an invalid route id to the disabled hook id", () => {
    routeParamsMock.mockReturnValue({ branchId: ["bad"] });

    render(<BranchDetailRoutePage />);

    expect(useBranchDetailMock).toHaveBeenCalledWith(
      "",
      expect.objectContaining({ staleTime: 30_000 }),
      { cacheScope: "org:acme" }
    );
    expect(branchDetailPageMock).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: "" }),
      undefined
    );
  });

  it("classifies a 404 detail failure as not-present", () => {
    useBranchDetailMock.mockReturnValue({
      data: undefined,
      error: new ApiError("Missing branch", 404),
      isError: true,
      isFetching: false,
      isLoading: false,
    });

    render(<BranchDetailRoutePage />);

    expect(branchDetailPageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "not-present",
        isError: true,
      }),
      undefined
    );
  });

  it("renders retryable refresh errors and keeps stale detail visible", async () => {
    invalidateQueriesMock.mockRejectedValue(new Error("provider down"));

    render(<BranchDetailRoutePage />);

    await clickRefreshButton();

    expect(branchDetailPageMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detail: { branchName: "feature/web-branches" },
        refreshState: "error",
      }),
      undefined
    );
    expect(invalidateQueriesMock).toHaveBeenCalledWith(
      { queryKey: ["branches", "detail"] },
      { throwOnError: true }
    );
    expect(invalidateQueriesMock).toHaveBeenCalledWith(
      { queryKey: ["branches", "trace"] },
      { throwOnError: true }
    );
  });

  it("renders successful refresh confirmations", async () => {
    invalidateQueriesMock.mockResolvedValue(undefined);

    render(<BranchDetailRoutePage />);

    await clickRefreshButton();

    expect(branchDetailPageMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ refreshState: "success" }),
      undefined
    );
  });

  it("starts backfill and invalidates detail after a connected return", async () => {
    searchParamsMock.mockReturnValue(new URLSearchParams("github=connected"));

    render(<BranchDetailRoutePage />);

    expect(
      screen.getByText("GitHub is connected. Branch details are refreshing.")
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        "/integrations/github/backfill",
        { mode: GitHubBackfillMode.Apply }
      )
    );
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ["github"],
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ["branches"],
    });
  });
});

async function clickRefreshButton() {
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: REFRESH_BUTTON_NAME_PATTERN })
    );
    await Promise.resolve();
  });
}
