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

function hasExactContentBody(_: string, element: Element | null): boolean {
  return (
    element?.tagName.toLowerCase() === "pre" &&
    element.textContent === "# Planner\n\nYou are a planner."
  );
}
