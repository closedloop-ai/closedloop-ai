/**
 * @file packs-workspace.test.tsx
 * @description Render tests for the shared, prototype-styled PacksWorkspace
 * across the desktop-team and web-admin contexts — the grid, search filter,
 * card → detail navigation, the admin Distribution tab, and the install callback
 * contract that the surface hosts wire to IPC / distribution management.
 */
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import {
  fireEvent,
  type RenderOptions,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { PackContentKind } from "../../lib/pack-view";
import { mockPackActivity, mockPackViews } from "../../lib/pack-view-mock";
import { createPacksContext, PacksMode } from "../../lib/packs-context";
import { PacksWorkspace } from "../packs-workspace";

// Clicking a pack card renders PackDetail, whose tabs adopt `useTabParam`
// (FEA-3557) — navigation-port hooks that require a <NavigationProvider>
// ancestor, exactly as the real web/desktop shells mount at the app root. Wrap
// every render in a memory-navigation provider (the same helper the pack-detail
// permalink and agent-detail suites use) instead of weakening the component.
function renderWithNav(ui: ReactElement, options?: RenderOptions) {
  const nav = createMemoryNavigation({
    initialPath: "/packs",
    orgSlug: "org-test",
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={nav.adapter}>{children}</NavigationProvider>
  );
  return render(ui, { wrapper, ...options });
}

// The collision qualifier leads the muted meta line (it is the signal, kept
// whole) with the publisher truncating after it, so they render as separate
// spans. A uniquely-named pack shows the publisher with no qualifier.
const IAC_QUALIFIER = "Iac Validation";
const PLAN_QUALIFIER = "Plan Review";

describe("PacksWorkspace", () => {
  it("renders a card per pack in the discovery grid", () => {
    renderWithNav(
      <PacksWorkspace
        activity={mockPackActivity}
        context={createPacksContext(PacksMode.DesktopTeam)}
        packs={mockPackViews}
      />
    );
    expect(screen.getByTestId("pack-card-code")).toBeDefined();
    expect(screen.getByTestId("pack-card-posthog")).toBeDefined();
    expect(screen.getByTestId("pack-card-self-learning")).toBeDefined();
  });

  it("filters the grid by the search query", () => {
    renderWithNav(
      <PacksWorkspace
        context={createPacksContext(PacksMode.DesktopTeam)}
        packs={mockPackViews}
      />
    );
    fireEvent.change(screen.getByLabelText("Search packs"), {
      target: { value: "posthog" },
    });
    expect(screen.getByTestId("pack-card-posthog")).toBeDefined();
    expect(screen.queryByTestId("pack-card-self-learning")).toBeNull();
  });

  it("finds a same-named card by its disambiguating qualifier", () => {
    const base = mockPackViews[0];
    renderWithNav(
      <PacksWorkspace
        context={createPacksContext(PacksMode.WebAdmin)}
        packs={[
          {
            ...base,
            id: "strat-iac",
            name: "test-strategist",
            category: "iac-validation",
            teamUsage: null,
          },
          {
            ...base,
            id: "strat-plan",
            name: "test-strategist",
            category: "plan-review",
            teamUsage: null,
          },
        ]}
      />
    );

    // A user reads "Iac Validation" off a card and types it into the box: the
    // card must survive the filter, not vanish (FEA-3972).
    fireEvent.change(screen.getByLabelText("Search packs"), {
      target: { value: "Iac Validation" },
    });
    expect(screen.getByTestId("pack-card-strat-iac")).toBeDefined();
    expect(screen.queryByTestId("pack-card-strat-plan")).toBeNull();
  });

  it("opens the detail view when a card is clicked", () => {
    renderWithNav(
      <PacksWorkspace
        context={createPacksContext(PacksMode.DesktopTeam)}
        packs={mockPackViews}
      />
    );
    fireEvent.click(screen.getByTestId("pack-card-code"));
    // The detail view exposes a back affordance and the tabbed sections.
    expect(screen.getByText("All plugins")).toBeDefined();
    expect(screen.getByRole("tab", { name: "Contents" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Team usage" })).toBeDefined();
  });

  it("renders canonical component content in the detail contents tab", () => {
    renderWithNav(
      <PacksWorkspace
        context={createPacksContext(PacksMode.WebAdmin)}
        packs={[
          {
            ...mockPackViews[0],
            contents: [
              {
                name: "planner",
                kind: PackContentKind.Agent,
                description: "Plans work",
                content: "# Planner\n\nYou are a planner.",
              },
            ],
          },
        ]}
      />
    );

    fireEvent.click(screen.getByTestId("pack-card-code"));

    expect(screen.getByText(hasExactContentBody)).toBeDefined();
  });

  it("web-admin detail exposes the Distribution tab", () => {
    renderWithNav(
      <PacksWorkspace
        context={createPacksContext(PacksMode.WebAdmin)}
        packs={mockPackViews}
      />
    );
    fireEvent.click(screen.getByTestId("pack-card-code"));
    expect(screen.getByRole("tab", { name: "Distribution" })).toBeDefined();
  });

  it("disambiguates same-named packs with a distinct card qualifier", () => {
    const base = mockPackViews[0];
    renderWithNav(
      <PacksWorkspace
        context={createPacksContext(PacksMode.WebAdmin)}
        packs={[
          {
            ...base,
            id: "test-strategist-iac",
            name: "test-strategist",
            publisher: "Your organization",
            category: "iac-validation",
            teamUsage: null,
          },
          {
            ...base,
            id: "test-strategist-plan",
            name: "test-strategist",
            publisher: "Your organization",
            category: "plan-review",
            teamUsage: null,
          },
          {
            ...base,
            id: "unique-pack",
            name: "security-privacy",
            publisher: "Your organization",
            category: "pack",
            teamUsage: null,
          },
        ]}
      />
    );

    // Both same-named cards carry a distinct, glanceable qualifier alongside the
    // publisher so the user can tell them apart at a glance.
    const iacCard = screen.getByTestId("pack-card-test-strategist-iac");
    const planCard = screen.getByTestId("pack-card-test-strategist-plan");
    expect(within(iacCard).getByText(IAC_QUALIFIER)).toBeDefined();
    expect(within(planCard).getByText(PLAN_QUALIFIER)).toBeDefined();

    // The uniquely-named pack renders cleanly with the publisher and no
    // collision qualifier at all.
    const uniqueCard = screen.getByTestId("pack-card-unique-pack");
    expect(within(uniqueCard).getByText("Your organization")).toBeDefined();
    expect(within(uniqueCard).queryByText(IAC_QUALIFIER)).toBeNull();
    expect(within(uniqueCard).queryByText(PLAN_QUALIFIER)).toBeNull();
  });

  // FEA-4132 removed the last gate on the extended content kinds (`plugin`,
  // `tool`), so they now render for everyone on every surface. The adapter tests
  // stub PacksWorkspace, so without a render regression here these kinds could
  // silently disappear again (as they did behind the flag) and stay green. Guard
  // both the card summary and the detail Contents section, on both the desktop
  // and web-admin contexts, so the shared component keeps rendering them.
  const EXTENDED_CONTENTS_MODES = [
    PacksMode.DesktopTeam,
    PacksMode.WebAdmin,
  ] as const;

  for (const mode of EXTENDED_CONTENTS_MODES) {
    it(`renders Plugin and Tool contents in the ${mode} card summary and Contents section`, () => {
      renderWithNav(
        <PacksWorkspace
          context={createPacksContext(mode)}
          packs={[
            {
              ...mockPackViews[0],
              id: "extended-pack",
              name: "extended-pack",
              teamUsage: null,
              contents: [
                {
                  name: "orchestrator",
                  kind: PackContentKind.Plugin,
                  description: "A bundled plugin",
                },
                {
                  name: "compile",
                  kind: PackContentKind.Tool,
                  description: "A bundled tool",
                },
              ],
            },
          ]}
        />
      );

      // Card summary counts the extended kinds (was hidden behind the flag).
      const card = screen.getByTestId("pack-card-extended-pack");
      expect(within(card).getByText("1 plugin · 1 tool")).toBeDefined();

      // The detail Contents tab renders a section per extended kind.
      fireEvent.click(card);
      const contents = screen.getByRole("tabpanel");
      expect(within(contents).getByText("Plugins")).toBeDefined();
      expect(within(contents).getByText("Tools")).toBeDefined();
      expect(within(contents).getByText("orchestrator")).toBeDefined();
      expect(within(contents).getByText("compile")).toBeDefined();
    });
  }

  // ISS-6767: `Popular`/`Trending` (and the Trending badge and Recommended
  // rail) all read `pack.teamUsage`, which no producer of the grid's rows
  // populates. A comparator handed such a corpus returns 0 for every pair, so
  // the control rendered and reordered nothing. These guard both directions —
  // dropped when the corpus cannot be ordered, offered and actually applied
  // when it can — so a future list-level producer is covered too.
  describe("sort controls over a corpus they cannot order", () => {
    // The desktop grid's real shape: `plugin-pack-view.ts` hardcodes
    // `teamUsage: null` on every row but carries real catalog stars.
    const withoutTeamUsage = mockPackViews.map((pack) => ({
      ...pack,
      teamUsage: null,
    }));

    // Producer order for both no-adoption cases below: deliberately NOT the
    // order any surviving comparator would produce, so a grid that quietly
    // adopted one shows up as a failure here.
    // stars: self-learning 540 < code 2140 < posthog 3420, so this order is
    // neither the Stars ranking nor the Name one.
    const producerOrder = [
      mockPackViews[2],
      mockPackViews[1],
      mockPackViews[0],
    ];

    it("drops Popular and Trending, and leaves the grid in producer order", () => {
      renderWithNav(
        <PacksWorkspace
          context={createPacksContext(PacksMode.DesktopTeam)}
          packs={producerOrder.map((pack) => ({ ...pack, teamUsage: null }))}
        />
      );

      const sortGroup = screen.getByLabelText("Sort packs");
      expect(within(sortGroup).queryByText("Popular")).toBeNull();
      expect(within(sortGroup).queryByText("Trending")).toBeNull();
      // Stars still separates this corpus, so it stays offered — but it is not
      // silently promoted into the dropped default's place. The grid keeps the
      // producer's order until the reader actually asks for a ranking …
      expect(renderedPackIds()).toEqual(["self-learning", "posthog", "code"]);
      // … and asking for one really applies it.
      fireEvent.click(within(sortGroup).getByText("Stars"));
      expect(renderedPackIds()).toEqual(["posthog", "code", "self-learning"]);
      // Releasing it puts the grid back. Producer order is only a state worth
      // rendering if the reader can RETURN to it: the group's deselect used to
      // be swallowed, which cost nothing while a mode was always applied and
      // would now strand anyone who clicked once until they reloaded.
      fireEvent.click(within(sortGroup).getByText("Stars"));
      expect(renderedPackIds()).toEqual(["self-learning", "posthog", "code"]);
    });

    it("renders no sort control when nothing can order the catalog", () => {
      // The web-admin grid's real shape: `catalog-item-to-pack-view.ts`
      // hardcodes BOTH `stars: null` and `teamUsage: null`, so every mode this
      // surface offers is inert. All three toggles go, and the grid keeps the
      // producer's order — exactly what it rendered before, minus the controls
      // that claimed to have ordered it.
      renderWithNav(
        <PacksWorkspace
          context={createPacksContext(PacksMode.WebAdmin)}
          packs={producerOrder.map((pack) => ({
            ...pack,
            stars: null,
            teamUsage: null,
          }))}
        />
      );

      expect(screen.queryByLabelText("Sort packs")).toBeNull();
      expect(renderedPackIds()).toEqual(["self-learning", "posthog", "code"]);
    });

    it("drops a mode whose key is uniform even when the block is present", () => {
      // Every pack carries team usage, but all with the same adoption — the
      // comparator still cannot separate them, so the toggle must not render.
      const flatAdoption = mockPackViews.map((pack) => ({
        ...pack,
        teamUsage: {
          installers: [],
          installedCount: 4,
          installTrend: [2, 2, 2],
        },
      }));
      renderWithNav(
        <PacksWorkspace
          context={createPacksContext(PacksMode.DesktopTeam)}
          packs={flatAdoption}
        />
      );

      const sortGroup = screen.getByLabelText("Sort packs");
      expect(within(sortGroup).queryByText("Popular")).toBeNull();
      expect(within(sortGroup).queryByText("Trending")).toBeNull();
    });

    it("offers Popular and Trending when the corpus carries real adoption", () => {
      renderWithNav(
        <PacksWorkspace
          context={createPacksContext(PacksMode.DesktopTeam)}
          packs={mockPackViews}
        />
      );

      const sortGroup = screen.getByLabelText("Sort packs");
      expect(within(sortGroup).getByText("Popular")).toBeDefined();
      expect(within(sortGroup).getByText("Trending")).toBeDefined();
      // Popular leads, so the grid is ranked by team install count …
      expect(renderedPackIds()).toEqual(["code", "posthog", "self-learning"]);
      // … and switching to Stars really re-ranks it.
      fireEvent.click(within(sortGroup).getByText("Stars"));
      expect(renderedPackIds()).toEqual(["posthog", "code", "self-learning"]);
    });

    it("hides the Trending badge and Recommended rail without team usage", () => {
      const { unmount } = renderWithNav(
        <PacksWorkspace
          context={createPacksContext(PacksMode.DesktopTeam)}
          packs={withoutTeamUsage}
        />
      );
      expect(screen.queryAllByLabelText("Trending")).toEqual([]);
      expect(screen.queryByText("Recommended for you")).toBeNull();
      unmount();

      // The same corpus with adoption lights both back up, proving the absence
      // above is the data's doing and not a dead render path.
      renderWithNav(
        <PacksWorkspace
          context={createPacksContext(PacksMode.DesktopTeam)}
          packs={mockPackViews}
        />
      );
      expect(screen.queryAllByLabelText("Trending").length).toBeGreaterThan(0);
      expect(screen.getByText("Recommended for you")).toBeDefined();
    });
  });

  // ISS-6925: pack detail became ADDRESSABLE. Supplying `selectedPackId` hands
  // selection to the host's route; these pin the states only a route can reach.
  describe("routed selection", () => {
    const BACK_HREF = "/org-test/packs";

    it("renders the detail for the pack the route addresses, with no click", () => {
      renderWithNav(
        <PacksWorkspace
          backHref={BACK_HREF}
          context={createPacksContext(PacksMode.DesktopTeam)}
          packs={mockPackViews}
          selectedPackId="code"
        />
      );

      expect(screen.getByRole("tab", { name: "Contents" })).toBeDefined();
      expect(screen.queryByTestId("pack-card-posthog")).toBeNull();
    });

    // The back affordance must be a real anchor so middle-click, Cmd-click and
    // "open in new tab" work — a navigation-only button cannot honor those.
    it("renders the back affordance as a link to the grid", () => {
      renderWithNav(
        <PacksWorkspace
          backHref={BACK_HREF}
          context={createPacksContext(PacksMode.DesktopTeam)}
          packs={mockPackViews}
          selectedPackId="code"
        />
      );

      expect(
        screen.getByRole("link", { name: "All plugins" }).getAttribute("href")
      ).toBe(BACK_HREF);
    });

    it("says the pack is missing when the route names one the catalog lacks", () => {
      renderWithNav(
        <PacksWorkspace
          backHref={BACK_HREF}
          context={createPacksContext(PacksMode.DesktopTeam)}
          packs={mockPackViews}
          selectedPackId="not-a-pack"
        />
      );

      expect(screen.getByText("Pack not found")).toBeDefined();
      // Never the discovery grid: answering a detail URL with the catalog is
      // the lie this state exists to prevent.
      expect(screen.queryByTestId("pack-card-code")).toBeNull();
    });

    // A failed detail read is evidence about the REQUEST, not about whether the
    // org's catalog carries the pack. Reporting it as "not found" would state a
    // fact about org state on the strength of a transport fault, and would offer
    // the reader no way forward but back to the grid.
    it("says the pack could not be loaded, not that it is missing, when the read fails", () => {
      const onDetailRetry = vi.fn();
      renderWithNav(
        <PacksWorkspace
          backHref={BACK_HREF}
          context={createPacksContext(PacksMode.DesktopTeam)}
          detailFailed
          onDetailRetry={onDetailRetry}
          packs={mockPackViews}
          selectedPackId="not-a-pack"
        />
      );

      expect(screen.getByText("Couldn't load this pack")).toBeDefined();
      expect(screen.queryByText("Pack not found")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(onDetailRetry).toHaveBeenCalledTimes(1);
    });

    // Pending outranks failed: a read still in flight has not failed yet.
    it("prefers the loading state over the failed one while both are set", () => {
      renderWithNav(
        <PacksWorkspace
          backHref={BACK_HREF}
          context={createPacksContext(PacksMode.DesktopTeam)}
          detailFailed
          detailPending
          packs={mockPackViews}
          selectedPackId="not-a-pack"
        />
      );

      expect(
        screen.getByRole("status", { name: "Loading pack" })
      ).toBeDefined();
      expect(screen.queryByText("Couldn't load this pack")).toBeNull();
    });

    it("says the pack is loading, not missing, while the detail read is in flight", () => {
      renderWithNav(
        <PacksWorkspace
          backHref={BACK_HREF}
          context={createPacksContext(PacksMode.DesktopTeam)}
          detailPending
          packs={mockPackViews}
          selectedPackId="not-yet-loaded"
        />
      );

      expect(
        screen.getByRole("status", { name: "Loading pack" })
      ).toBeDefined();
      expect(screen.queryByText("Pack not found")).toBeNull();
    });

    // The flag-off shape is unchanged, and that is the half a new state could
    // silently take over: uncontrolled, an unresolvable id still falls through
    // to the grid exactly as it ships today.
    it("keeps falling through to the grid when the WORKSPACE owns selection", () => {
      renderWithNav(
        <PacksWorkspace
          context={createPacksContext(PacksMode.DesktopTeam)}
          packs={mockPackViews}
        />
      );

      expect(screen.getByTestId("pack-card-code")).toBeDefined();
      expect(screen.queryByText("Pack not found")).toBeNull();
    });
  });

  it("fires onInstall with the pack id from a card quick-install", () => {
    const onInstall = vi.fn();
    renderWithNav(
      <PacksWorkspace
        context={createPacksContext(PacksMode.DesktopTeam)}
        onInstall={onInstall}
        packs={mockPackViews}
      />
    );
    // posthog is not installed by me → its card shows a quick Install.
    const card = screen.getByTestId("pack-card-posthog");
    fireEvent.click(within(card).getByText("Install"));
    expect(onInstall).toHaveBeenCalledWith("posthog");
  });
});

/** The grid's rendered pack ids, in render order (the applied sort). */
function renderedPackIds(): string[] {
  return Array.from(
    document.querySelectorAll("[data-testid^='pack-card-']")
  ).map((card) =>
    (card.getAttribute("data-testid") ?? "").replace("pack-card-", "")
  );
}

function hasExactContentBody(_: string, element: Element | null): boolean {
  return (
    element?.tagName.toLowerCase() === "pre" &&
    element.textContent === "# Planner\n\nYou are a planner."
  );
}
