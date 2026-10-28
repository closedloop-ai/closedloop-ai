/**
 * @file packs-workspace-filters.test.tsx
 * @description PacksWorkspace grid behavior not covered by the main suite:
 * category filtering, the empty/filtered states, non-team sort modes, the
 * toolbar slot, the unrouted back button, and detail-pack resolution.
 */
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { categoryDisplayLabel, type PackView } from "../../lib/pack-view";
import { mockPackViews } from "../../lib/pack-view-mock";
import { createPacksContext, PacksMode } from "../../lib/packs-context";
import { PacksWorkspace } from "../packs-workspace";

const EMPTY_TITLE = "No packs match your filters";
const CLEAR_FILTERS = "Clear filters";
const RECOMMENDED_TITLE = "Recommended for you";

function renderWithNav(ui: ReactElement) {
  const nav = createMemoryNavigation({
    initialPath: "/packs",
    orgSlug: "org-test",
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={nav.adapter}>{children}</NavigationProvider>
  );
  return render(ui, { wrapper });
}

function renderedPackIds(): string[] {
  return Array.from(
    document.querySelectorAll("[data-testid^='pack-card-']")
  ).map((card) =>
    (card.getAttribute("data-testid") ?? "").replace("pack-card-", "")
  );
}

function packAt(index: number): PackView {
  const pack = mockPackViews[index];
  if (pack === undefined) {
    throw new Error(`missing mock pack ${index}`);
  }
  return pack;
}

describe("PacksWorkspace filtering", () => {
  it("narrows the grid to the chosen category and clears back to all", () => {
    renderWithNav(
      <PacksWorkspace
        context={createPacksContext(PacksMode.DesktopTeam)}
        packs={mockPackViews}
      />
    );
    const trigger = screen.getByRole("combobox", { name: "Category" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    const option = screen.getByRole("option", {
      name: categoryDisplayLabel(packAt(1).category ?? ""),
    });
    fireEvent.keyDown(option, { key: "Enter" });
    expect(renderedPackIds()).toEqual(["posthog"]);

    fireEvent.change(screen.getByLabelText("Search packs"), {
      target: { value: "closedloop" },
    });
    expect(screen.getByText(EMPTY_TITLE)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: CLEAR_FILTERS }));
    expect(renderedPackIds()).toEqual(["code", "posthog", "self-learning"]);
    expect(
      (screen.getByLabelText("Search packs") as HTMLInputElement).value
    ).toBe("");
  });

  it("matches packs with no publisher or description by name", () => {
    renderWithNav(
      <PacksWorkspace
        context={createPacksContext(PacksMode.DesktopSolo)}
        packs={[
          { ...packAt(0), publisher: null, description: null, category: null },
        ]}
      />
    );
    expect(screen.queryByRole("combobox", { name: "Category" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Search packs"), {
      target: { value: "COD" },
    });
    expect(renderedPackIds()).toEqual(["code"]);
    fireEvent.change(screen.getByLabelText("Search packs"), {
      target: { value: "null" },
    });
    expect(renderedPackIds()).toEqual([]);
  });

  it("renders a host-supplied empty state instead of the default one", () => {
    renderWithNav(
      <PacksWorkspace
        context={createPacksContext(PacksMode.DesktopTeam)}
        emptyState={<p>Nothing installed yet</p>}
        packs={[]}
      />
    );
    expect(screen.getByText("Nothing installed yet")).toBeDefined();
    expect(screen.queryByText(EMPTY_TITLE)).toBeNull();
    expect(screen.queryByLabelText("Sort packs")).toBeNull();
  });

  it("renders the toolbar slot above the grid", () => {
    renderWithNav(
      <PacksWorkspace
        context={createPacksContext(PacksMode.DesktopTeam)}
        packs={mockPackViews}
        toolbarSlot={<button type="button">New plugin</button>}
      />
    );
    expect(screen.getByRole("button", { name: "New plugin" })).toBeDefined();
  });
});

describe("PacksWorkspace solo sort modes", () => {
  it("defaults to Stars, offers Name, and hides the team rail", () => {
    renderWithNav(
      <PacksWorkspace
        context={createPacksContext(PacksMode.DesktopSolo)}
        packs={mockPackViews}
      />
    );
    const sortGroup = screen.getByLabelText("Sort packs");
    expect(
      within(sortGroup)
        .getAllByRole("radio")
        .map((item) => item.textContent)
    ).toEqual(["Stars", "Name"]);
    expect(renderedPackIds()).toEqual(["posthog", "code", "self-learning"]);
    fireEvent.click(within(sortGroup).getByText("Name"));
    expect(renderedPackIds()).toEqual(["code", "posthog", "self-learning"]);
    expect(screen.queryByText(RECOMMENDED_TITLE)).toBeNull();
  });
});

describe("PacksWorkspace detail resolution", () => {
  it("prefers the loaded detail pack and returns to the grid via the back button", () => {
    const onSelectPack = vi.fn();
    const detailName = "code (full detail)";
    renderWithNav(
      <PacksWorkspace
        context={createPacksContext(PacksMode.DesktopTeam)}
        detailPack={{ ...packAt(0), name: detailName }}
        onSelectPack={onSelectPack}
        packs={mockPackViews}
      />
    );
    fireEvent.click(screen.getByTestId("pack-card-code"));
    expect(onSelectPack).toHaveBeenLastCalledWith("code");
    expect(screen.getAllByText(detailName).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "All plugins" }));
    expect(onSelectPack).toHaveBeenLastCalledWith(null);
    expect(screen.getByTestId("pack-card-posthog")).toBeDefined();
  });

  it("falls back to the list item when the detail pack is for another id", () => {
    renderWithNav(
      <PacksWorkspace
        context={createPacksContext(PacksMode.DesktopTeam)}
        detailPack={{ ...packAt(1), name: "stale posthog detail" }}
        packs={mockPackViews}
        selectedPackId="code"
      />
    );
    expect(screen.queryByText("stale posthog detail")).toBeNull();
    expect(screen.getByRole("tab", { name: "Contents" })).toBeDefined();
  });

  it("does not change its own selection when the route owns it", () => {
    const onSelectPack = vi.fn();
    renderWithNav(
      <PacksWorkspace
        context={createPacksContext(PacksMode.DesktopTeam)}
        onSelectPack={onSelectPack}
        packs={mockPackViews}
        selectedPackId={null}
      />
    );
    fireEvent.click(screen.getByTestId("pack-card-code"));
    expect(onSelectPack).toHaveBeenCalledWith("code");
    expect(screen.getByTestId("pack-card-code")).toBeDefined();
    expect(screen.queryByRole("tab", { name: "Contents" })).toBeNull();
  });
});
