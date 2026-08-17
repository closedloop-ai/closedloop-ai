/**
 * FEA-4228 (wongk, thread 2): a flag-off direct route hit must land on the REAL
 * in-shell "Page not found" recovery state with a working "Back to dashboard"
 * link — not a blank page, and not merely "the old page is absent". The gate's
 * flag-off branch raises `notFound()`, which the App Router resolves to this
 * `AuthenticatedNotFound` boundary; these tests render that boundary directly
 * and assert the recovery affordance on both the org-scoped and non-org
 * (self-scoped) Sessions paths.
 */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import AuthenticatedNotFound from "../not-found";

const { useOrgPathMock } = vi.hoisted(() => ({ useOrgPathMock: vi.fn() }));

vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => useOrgPathMock(),
}));

// Render the navigation Link as a plain anchor so the href (the recovery
// affordance the test asserts) is inspectable without a navigation provider.
vi.mock("@repo/navigation/link", () => ({
  Link: ({
    children,
    href,
    className,
  }: {
    children: ReactNode;
    href: string;
    className?: string;
  }) => (
    <a className={className} href={href}>
      {children}
    </a>
  ),
}));

describe("AuthenticatedNotFound recovery state (flag-off direct-route landing)", () => {
  it("renders the in-shell Page not found state with a Back-to-dashboard link on the org Sessions path", () => {
    // Org-scoped builder: /acme/sessions → /acme/dashboard.
    useOrgPathMock.mockReturnValue((path: string) => `/acme${path}`);

    render(<AuthenticatedNotFound />);

    // The 404 IS the whole page here, so its title is the page's `h1` — a real
    // heading, not a styled `div`. Without it the recovery screen has no
    // heading at all, so a screen-reader user landing on a stale bookmark gets
    // an unlabelled region, and heading-based navigation skips straight past
    // the only thing on the page (ISS-5011, PR #4501).
    expect(
      screen.getByRole("heading", { level: 1, name: "Page not found" })
    ).toBeInTheDocument();
    expect(screen.getByText("This page isn't available.")).toBeInTheDocument();
    const recoveryLink = screen.getByRole("link", {
      name: "Back to dashboard",
    });
    expect(recoveryLink).toHaveAttribute("href", "/acme/dashboard");
  });

  it("renders the same recovery state with a Back-to-dashboard link on the non-org Sessions path", () => {
    // Non-org (self-scoped) builder: /sessions → /dashboard.
    useOrgPathMock.mockReturnValue((path: string) => path);

    render(<AuthenticatedNotFound />);

    expect(screen.getByText("Page not found")).toBeInTheDocument();
    const recoveryLink = screen.getByRole("link", {
      name: "Back to dashboard",
    });
    expect(recoveryLink).toHaveAttribute("href", "/dashboard");
  });
});
