/**
 * @file packs-view.test.tsx
 * @description Unit test for the desktop Packs view (FEA-4087 Slice 1, member
 * slot realized in FEA-4166).
 *
 * Proves the desktop mount of the shared `PacksPage` spine: the view renders
 * under a PageShell titled "Packs" and, in the `DesktopTeam` capability context
 * (no distribution authoring), resolves to the member-facing pack surface — the
 * by-source `DesktopMemberPacksView` (FEA-4166), not an admin treatment. The
 * member view is stubbed so the test targets the desktop spine wiring, not the
 * member adapter's own data contract (member-packs-view.test.tsx covers that).
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PacksView } from "../packs-view";

// Stub the member pack surface: the desktop view's job here is to mount the
// shared spine in the right capability context and shell, not to drive the
// member adapter's data hooks.
vi.mock("../member-packs-view", () => ({
  DesktopMemberPacksView: () => <div data-testid="desktop-member-packs-view" />,
}));

// The admin slot is never reached on DesktopTeam (no manageDistribution), but it
// is still wired to PluginsPanel; stub it so a spine regression that flipped to
// the admin branch is caught by the member assertion below, not a panel crash.
vi.mock("../../agents/plugins-panel", () => ({
  PluginsPanel: () => <div data-testid="plugins-panel" />,
}));

describe("PacksView (desktop)", () => {
  it("renders the Packs shell with the by-source member pack surface for a desktop context", () => {
    render(<PacksView />);

    // getByRole throws if absent, so a defined result proves the shell heading.
    expect(
      screen.getByRole("heading", { name: "Packs", level: 1 })
    ).toBeDefined();
    // DesktopTeam has no manageDistribution capability, so the spine renders the
    // member treatment (the by-source MemberView adapter), not the admin slot.
    expect(screen.getByTestId("desktop-member-packs-view")).toBeDefined();
    expect(screen.queryByTestId("plugins-panel")).toBeNull();
  });
});
