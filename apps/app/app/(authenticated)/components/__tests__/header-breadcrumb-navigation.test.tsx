/**
 * @file header-breadcrumb-navigation.test.tsx
 * @description Web-adapter interaction test for the shared authenticated
 * {@link Header} chrome (FEA-4260). The session / branch / component detail
 * pages all converge on this one header contract — breadcrumb (with a linked
 * parent "back" crumb) on the left, primary action on the right. This asserts
 * the parent-crumb "back" affordance routes through the `@repo/navigation`
 * Link port (not the raw `<a>` `BreadcrumbLink` renders by default), so the
 * same crumb navigates on web AND under the desktop renderer's Electron
 * will-navigate guard, and that clicking it actually navigates.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The shared header renders the surface-agnostic navigation Link for its
// breadcrumb "back" crumb. Capture the navigated href here so the test proves
// the crumb goes through the port (a raw <a> would dead-click on desktop),
// while still rendering a real anchor so it reads as a role="link".
const navigate = vi.fn();
vi.mock("@repo/navigation/link", () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        navigate(href);
      }}
      {...rest}
    >
      {children}
    </a>
  ),
}));

// The sidebar trigger needs a SidebarProvider it does not have here, and the
// mobile search overlay pulls the whole search stack — neither is the header
// chrome under test, so keep them transparent.
vi.mock("@repo/design-system/components/ui/sidebar", () => ({
  SidebarTrigger: () => null,
}));
vi.mock("../mobile-search-overlay", () => ({
  MobileSearchOverlay: () => null,
}));

import { Header } from "../header";

const SESSIONS_HREF = "/acme/sessions";

describe("Header breadcrumb back affordance (FEA-4260)", () => {
  it("renders the parent crumb as a navigation-port link and navigates on click", () => {
    render(
      <Header
        breadcrumbs={[
          { label: "Sessions", href: SESSIONS_HREF },
          { label: "My Session" },
        ]}
      >
        <button type="button">Refresh</button>
      </Header>
    );

    // The page name also appears as the header's `h1` (ISS-5008), so scope the
    // crumb assertions to the breadcrumb landmark rather than the whole header.
    const nav = screen.getByRole("navigation", { name: "breadcrumb" });

    // The trailing crumb is the current page — marked aria-current and NOT a
    // real anchor (the DS BreadcrumbPage renders a span, so it can't navigate).
    const current = within(nav).getByText("My Session");
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(current.tagName).not.toBe("A");

    // The parent crumb is a real anchor to the list, and clicking it navigates
    // through the port rather than dead-clicking.
    const parentCrumb = within(nav).getByRole("link", { name: "Sessions" });
    expect(parentCrumb.tagName).toBe("A");
    expect(parentCrumb.getAttribute("href")).toBe(SESSIONS_HREF);

    fireEvent.click(parentCrumb);
    expect(navigate).toHaveBeenCalledWith(SESSIONS_HREF);
  });

  it("keeps the primary action in the right-hand slot, outside the breadcrumb cluster", () => {
    render(
      <Header breadcrumbs={[{ label: "Branches" }]}>
        <button type="button">Refresh</button>
      </Header>
    );

    const refresh = screen.getByRole("button", { name: "Refresh" });
    const nav = screen.getByRole("navigation", { name: "breadcrumb" });

    // The action must live in the header's right-hand slot, never inside the
    // left breadcrumb cluster — moving it under the crumbs must fail this.
    expect(nav.contains(refresh)).toBe(false);

    // The right slot is the header's trailing flex row (the last child of the
    // <header>), the sibling of the left breadcrumb column that holds the nav.
    const header = nav.closest("header");
    expect(header).not.toBeNull();
    const rightSlot = header?.lastElementChild ?? null;
    expect(rightSlot).not.toBeNull();
    expect(rightSlot?.contains(refresh)).toBe(true);
    expect(rightSlot?.contains(nav)).toBe(false);
  });
});
