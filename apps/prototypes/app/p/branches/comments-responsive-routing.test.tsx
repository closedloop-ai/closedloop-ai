// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebMasterBranchesPage from "../web-master/branches/page";
import { MetricPresentationState } from "./components/branch-list-metric-types";
import type { BranchListViewState } from "./components/branch-list-state";
import BranchesPrototypePage from "./page";

const SAML_BRANCH = "agent/saml-sso-implementation";
const PR_COMMENTS_NAME = /PR comments/;
const searchState = vi.hoisted(() => ({ value: null as string | null }));

vi.mock("next/navigation", () => ({
  useSearchParams: () =>
    new URLSearchParams(
      searchState.value === null ? "" : `metricsState=${searchState.value}`
    ),
}));

vi.mock("./components/app-shell", () => ({
  AppShell: ({
    actions,
    breadcrumbs,
    children,
  }: {
    actions?: ReactNode;
    breadcrumbs?: Array<{ label: string; onSelect?: () => void }>;
    children: ReactNode;
  }) => (
    <div>
      {actions}
      {breadcrumbs?.map((breadcrumb) =>
        breadcrumb.onSelect ? (
          <button
            key={breadcrumb.label}
            onClick={breadcrumb.onSelect}
            type="button"
          >
            {breadcrumb.label}
          </button>
        ) : null
      )}
      {children}
    </div>
  ),
}));

vi.mock("@/app/p/web-master/components/page-chrome", () => ({
  PageChrome: ({
    actions,
    breadcrumbs,
    children,
  }: {
    actions?: ReactNode;
    breadcrumbs?: Array<{ label: string; onSelect?: () => void }>;
    children: ReactNode;
  }) => (
    <div>
      {actions}
      {breadcrumbs?.map((breadcrumb) =>
        breadcrumb.onSelect ? (
          <button
            key={breadcrumb.label}
            onClick={breadcrumb.onSelect}
            type="button"
          >
            {breadcrumb.label}
          </button>
        ) : null
      )}
      {children}
    </div>
  ),
}));

vi.mock("./components/branches-list", () => ({
  BranchesList: ({
    onOpenDetail,
    onStateChange,
    state,
    presentationState,
  }: {
    onOpenDetail: (row: object) => void;
    onStateChange: (state: BranchListViewState) => void;
    state: BranchListViewState;
    presentationState: string;
  }) => (
    <div>
      <span>{`Page ${state.page + 1} ${state.sortBy}`}</span>
      <span>{`Metrics ${presentationState}`}</span>
      <button
        onClick={() => onStateChange({ ...state, page: 2, sortBy: "status" })}
        type="button"
      >
        Change list state
      </button>
      <button
        onClick={() =>
          onOpenDetail({ id: "branch-a", branchName: SAML_BRANCH })
        }
        type="button"
      >
        {SAML_BRANCH}
      </button>
    </div>
  ),
}));

vi.mock("./components/branch-detail", () => ({
  BranchDetailTab: {
    Details: "branch-details",
    Sessions: "sessions-timeline",
  },
  BranchDetailView: ({ commentsCollapsed }: { commentsCollapsed: boolean }) =>
    commentsCollapsed ? null : (
      <aside aria-label="PR comments">PR comments</aside>
    ),
}));

vi.mock("./mock-detail", () => ({
  buildBranchDetail: (row: { id: string }) => ({ id: row.id }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  searchState.value = null;
});

describe.each([
  ["standalone", BranchesPrototypePage],
  ["web master", WebMasterBranchesPage],
])("%s Branches route", (_label, RouteComponent) => {
  it("keeps comments closed by default at narrow widths", () => {
    stubMatchMedia(false);
    render(<RouteComponent />);

    fireEvent.click(screen.getByRole("button", { name: SAML_BRANCH }));

    expect(
      screen.getByRole("button", { name: "Show comments rail" })
    ).not.toBeNull();
    expect(
      screen.queryByRole("complementary", { name: PR_COMMENTS_NAME })
    ).toBeNull();
  });

  it("shows comments by default at wide widths", () => {
    stubMatchMedia(true);
    render(<RouteComponent />);

    fireEvent.click(screen.getByRole("button", { name: SAML_BRANCH }));

    expect(
      screen.getByRole("button", { name: "Hide comments rail" })
    ).not.toBeNull();
    expect(
      screen.getByRole("complementary", { name: PR_COMMENTS_NAME })
    ).not.toBeNull();
  });

  it("restores route-owned list state after detail and back", () => {
    stubMatchMedia(false);
    render(<RouteComponent />);

    fireEvent.click(screen.getByRole("button", { name: "Change list state" }));
    fireEvent.click(screen.getByRole("button", { name: SAML_BRANCH }));
    fireEvent.click(screen.getByRole("button", { name: "Branches" }));

    expect(screen.getByText("Page 3 status")).not.toBeNull();
  });

  it("reacts to supported metricsState query changes", () => {
    searchState.value = MetricPresentationState.Partial;
    const { rerender } = render(<RouteComponent />);
    expect(screen.getByText("Metrics partial")).not.toBeNull();

    searchState.value = MetricPresentationState.Error;
    rerender(<RouteComponent />);
    expect(screen.getByText("Metrics error")).not.toBeNull();
  });

  it("falls back for invalid and oversized metricsState values", () => {
    searchState.value = "invalid";
    const { rerender } = render(<RouteComponent />);
    expect(screen.getByText("Metrics complete")).not.toBeNull();

    searchState.value = "x".repeat(65);
    rerender(<RouteComponent />);
    expect(screen.getByText("Metrics complete")).not.toBeNull();
  });
});

function stubMatchMedia(wideRail: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        addEventListener: () => undefined,
        addListener: () => undefined,
        dispatchEvent: () => false,
        matches: wideRail && query === "(min-width: 1025px)",
        media: query,
        onchange: null,
        removeEventListener: () => undefined,
        removeListener: () => undefined,
      }) as MediaQueryList
  );
}
