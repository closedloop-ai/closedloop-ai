/**
 * @file header-page-heading.test.tsx
 * @description ISS-5008. Eight of the nine authenticated web routes measured in
 * production rendered zero `h1`: the page name lived only in the breadcrumb
 * bar, which is a `nav`, not a heading — so a screen-reader user navigating by
 * heading had no entry point and could not tell which page they were on. The
 * shared {@link Header} now carries the page's `h1`, named by the current
 * crumb, for every route that does not render its own.
 *
 * WCAG 2.1 SC 1.3.1 (Info and Relationships) and SC 2.4.6 (Headings and
 * Labels).
 */
import { expectCriticalAxeClean } from "@repo/app/test/a11y/axe";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/navigation/link", () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// Neither the sidebar trigger (needs a SidebarProvider) nor the mobile search
// overlay (pulls the whole search stack) is the heading contract under test.
vi.mock("@repo/design-system/components/ui/sidebar", () => ({
  SidebarTrigger: () => null,
}));
vi.mock("../mobile-search-overlay", () => ({
  MobileSearchOverlay: () => null,
}));

import { Header } from "../header";

function headings(): string[] {
  return screen
    .queryAllByRole("heading", { level: 1 })
    .map((node) => node.textContent ?? "");
}

describe("Header page heading (ISS-5008)", () => {
  it("renders exactly one h1 naming the current page", () => {
    render(<Header breadcrumbs={[{ label: "Sessions" }]} />);

    expect(headings()).toEqual(["Sessions"]);
  });

  it("names the h1 from the current crumb, not an ancestor", () => {
    render(
      <Header
        breadcrumbs={[
          { label: "Sessions", href: "/acme/sessions" },
          { label: "My Session" },
        ]}
      />
    );

    expect(headings()).toEqual(["My Session"]);
  });

  it("keeps the heading out of the breadcrumb navigation landmark", () => {
    render(
      <Header
        breadcrumbs={[
          { label: "Documents", href: "/acme/documents" },
          { label: "PRD-586" },
        ]}
      />
    );

    // A heading inside `nav` would name the navigation region rather than the
    // page, so heading navigation must not land the user inside the crumb bar.
    const nav = screen.getByRole("navigation", { name: "breadcrumb" });
    const heading = screen.getByRole("heading", { level: 1 });
    expect(nav.contains(heading)).toBe(false);
  });

  it("renders no h1 when the page owns its own heading", () => {
    render(
      <Header breadcrumbs={[{ label: "Dashboard" }]} suppressPageHeading />
    );

    expect(headings()).toEqual([]);
  });

  it("renders no heading when there is no crumb to name the page", () => {
    render(<Header breadcrumbs={[]} />);

    expect(headings()).toEqual([]);
  });

  it("has no critical accessibility violations", async () => {
    const { container } = render(
      <Header
        breadcrumbs={[
          { label: "Sessions", href: "/acme/sessions" },
          { label: "My Session" },
        ]}
      >
        <button type="button">Refresh</button>
      </Header>
    );

    await expectCriticalAxeClean(container);
  });
});
