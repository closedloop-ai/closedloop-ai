/**
 * @file packs-workspace.test.tsx
 * @description Render tests for the shared, prototype-styled PacksWorkspace
 * across the desktop-team and web-admin contexts — the grid, search filter,
 * card → detail navigation, the admin Distribution tab, and the install callback
 * contract that the surface hosts wire to IPC / distribution management.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { mockPackActivity, mockPackViews } from "../../lib/pack-view-mock";
import { createPacksContext, PacksMode } from "../../lib/packs-context";
import { PacksWorkspace } from "../packs-workspace";

describe("PacksWorkspace", () => {
  it("renders a card per pack in the discovery grid", () => {
    render(
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
    render(
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

  it("opens the detail view when a card is clicked", () => {
    render(
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

  it("web-admin detail exposes the Distribution tab", () => {
    render(
      <PacksWorkspace
        context={createPacksContext(PacksMode.WebAdmin)}
        packs={mockPackViews}
      />
    );
    fireEvent.click(screen.getByTestId("pack-card-code"));
    expect(screen.getByRole("tab", { name: "Distribution" })).toBeDefined();
  });

  it("fires onInstall with the pack id from a card quick-install", () => {
    const onInstall = vi.fn();
    render(
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
