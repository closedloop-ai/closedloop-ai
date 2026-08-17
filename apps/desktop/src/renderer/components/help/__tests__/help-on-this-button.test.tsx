/**
 * @file help-on-this-button.test.tsx
 * @description Component tests for the contextual "Help on this" header
 * affordance (FEA-3846 / PRD-555 M4). Renders {@link HelpOnThisButton} with a
 * mocked `docsHelp` flag and a stubbed navigation `Link`, and asserts:
 *   1. Flag ON + an anchor → the affordance renders as an accessible-named link
 *      deep-linking the Help view to the declared page (+ heading) via
 *      `helpPageHref`.
 *   2. Flag OFF → nothing renders (the whole Docs/Help surface stays dark).
 *   3. Flag ON but no anchor declared → nothing renders.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: vi.fn(),
}));

// The design-system Tooltip wraps the trigger in Radix portals/providers; the
// affordance itself is what we assert, so keep Tooltip transparent (render its
// children) to avoid pulling ResizeObserver/portal shims into this test.
vi.mock("@closedloop-ai/design-system/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: ({ children }: { children: React.ReactNode }) => children,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Render the surface-agnostic navigation Link as a plain anchor so we can assert
// the href without mounting a NavigationProvider adapter.
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

import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY } from "../../../../shared/desktop-docs-help-flag";
import type { DocsAnchor } from "../../../navigation/docs-anchor";
import { HelpOnThisButton } from "../help-on-this-button";

const flagMock = vi.mocked(useFeatureFlagEnabled);
const LABEL = "Help on this screen";
const docsHelpOnlyFlags = (key: string) =>
  key === DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY;

afterEach(() => {
  vi.clearAllMocks();
});

describe("HelpOnThisButton (FEA-3846)", () => {
  it("renders an accessible link to the Help view at the declared page + heading when the flag is on", () => {
    flagMock.mockReturnValue(true);
    const anchor: DocsAnchor = {
      page: "desktop-app/gateway",
      heading: "authentication",
    };
    render(<HelpOnThisButton anchor={anchor} />);

    const link = screen.getByRole("link", { name: LABEL });
    expect(link.getAttribute("href")).toBe(
      "/help?page=desktop-app%2Fgateway&heading=authentication"
    );
    // Clickable — no error, the anchor carries the deep-link the router consumes.
    fireEvent.click(link);
  });

  it("links without a heading param when the anchor declares only a page", () => {
    flagMock.mockReturnValue(true);
    render(<HelpOnThisButton anchor={{ page: "desktop-app/overview" }} />);

    const link = screen.getByRole("link", { name: LABEL });
    expect(link.getAttribute("href")).toBe("/help?page=desktop-app%2Foverview");
  });

  it("renders nothing when the docsHelp flag is off", () => {
    flagMock.mockReturnValue(false);
    const { container } = render(
      <HelpOnThisButton anchor={{ page: "desktop-app/overview" }} />
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  // ISS-5037 (wongk review on PR #4341): `docsHelp` stays TRUE here. The Labs
  // container gate above it is off, which is what withdrew the Help destination
  // — this button must not keep offering a jump to it.
  it("renders nothing when docsHelp is on but the Labs container gate is off", () => {
    flagMock.mockImplementation(docsHelpOnlyFlags);
    const { container } = render(
      <HelpOnThisButton anchor={{ page: "desktop-app/overview" }} />
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders nothing when the screen declares no anchor", () => {
    flagMock.mockReturnValue(true);
    const { container } = render(<HelpOnThisButton anchor={null} />);
    expect(container.firstChild).toBeNull();
  });
});
