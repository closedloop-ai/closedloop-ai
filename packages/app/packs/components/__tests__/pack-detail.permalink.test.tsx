import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { mockPackViews } from "../../lib/pack-view-mock";
import { createPacksContext, PacksMode } from "../../lib/packs-context";
import { PackDetail } from "../pack-detail";

/**
 * FEA-3557: permalink adoption for the pack-detail tabs
 * (Contents / Team usage / Performance / Distribution).
 *
 * The active tab now lives in the `?tab=` URL param via `useTabParam` (through
 * the `packages/navigation` port → web + desktop). validTabs is built from only
 * the capability-gated tabs actually rendered, so a deep-link to a hidden tab
 * falls back to "contents". PackDetail only depends on the navigation port, so
 * a bare NavigationProvider is sufficient.
 */

// WebAdmin surfaces all four tabs (manageDistribution + showTeamUsage +
// showPerformance), and mockPackViews[0] carries teamUsage/performance data.
const CONTEXT = createPacksContext(PacksMode.WebAdmin);
const PACK = mockPackViews[0];

function tabQuery(href: string): string | null {
  const q = href.indexOf("?");
  return new URLSearchParams(q === -1 ? "" : href.slice(q + 1)).get("tab");
}

function renderPack(initialPath: string) {
  const nav = createMemoryNavigation({ initialPath, orgSlug: "org-test" });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={nav.adapter}>{children}</NavigationProvider>
  );
  const view = render(<PackDetail context={CONTEXT} pack={PACK} />, {
    wrapper,
  });
  return { nav, ...view };
}

describe("PackDetail tab permalink (FEA-3557)", () => {
  it("defaults to Contents with no ?tab= param", () => {
    const { nav } = renderPack("/packs/code");

    expect(screen.getByRole("tab", { name: "Contents" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(tabQuery(nav.getCurrentHref())).toBeNull();
  });

  it("deep-links straight to the Distribution tab from ?tab=distribution", () => {
    renderPack("/packs/code?tab=distribution");

    expect(screen.getByRole("tab", { name: "Distribution" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("falls back to Contents for an invalid ?tab= value", () => {
    renderPack("/packs/code?tab=bogus");

    expect(screen.getByRole("tab", { name: "Contents" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("writes ?tab= on switch and cleans the default back out", async () => {
    const user = userEvent.setup();
    const { nav } = renderPack("/packs/code");

    await user.click(screen.getByRole("tab", { name: "Performance" }));
    await waitFor(() => {
      expect(tabQuery(nav.getCurrentHref())).toBe("performance");
    });

    await user.click(screen.getByRole("tab", { name: "Contents" }));
    await waitFor(() => {
      expect(tabQuery(nav.getCurrentHref())).toBeNull();
    });
  });
});
