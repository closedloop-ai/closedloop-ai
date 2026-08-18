// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import WebMasterBranchesPage from "../web-master/branches/page";
import BranchesPrototypePage from "./page";

const VISIBLE_BRANCH = "agent/design-system-dark-mode";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("./components/app-shell", () => ({
  AppShell: TestShell,
}));

vi.mock("@/app/p/web-master/components/page-chrome", () => ({
  PageChrome: TestShell,
}));

vi.mock("./components/branch-detail", () => ({
  BranchDetailTab: {
    Details: "branch-details",
    Sessions: "sessions-timeline",
  },
  BranchDetailView: () => <div>Branch detail</div>,
}));

vi.mock("./mock-detail", () => ({
  buildBranchDetail: (row: { id: string }) => ({ id: row.id }),
}));

describe.each([
  ["standalone", BranchesPrototypePage],
  ["web master", WebMasterBranchesPage],
])("%s Branches real-list restoration", (_label, RouteComponent) => {
  it("preserves a real date control through detail and back", () => {
    stubMatchMedia();
    render(<RouteComponent />);

    fireEvent.click(screen.getByRole("radio", { name: "Last 90 days" }));
    expect(
      screen
        .getByRole("radio", { name: "Last 90 days" })
        .getAttribute("aria-checked")
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: VISIBLE_BRANCH }));
    fireEvent.click(screen.getByRole("button", { name: "Branches" }));

    expect(
      screen
        .getByRole("radio", { name: "Last 90 days" })
        .getAttribute("aria-checked")
    ).toBe("true");
  });
});

function TestShell({
  breadcrumbs,
  children,
}: {
  breadcrumbs?: Array<{ label: string; onSelect?: () => void }>;
  children: ReactNode;
}) {
  return (
    <div>
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
  );
}

function stubMatchMedia() {
  vi.stubGlobal(
    "matchMedia",
    () =>
      ({
        addEventListener: () => undefined,
        addListener: () => undefined,
        dispatchEvent: () => false,
        matches: false,
        media: "(min-width: 1025px)",
        onchange: null,
        removeEventListener: () => undefined,
        removeListener: () => undefined,
      }) as MediaQueryList
  );
}
