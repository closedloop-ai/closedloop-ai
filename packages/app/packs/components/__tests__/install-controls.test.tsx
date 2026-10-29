/**
 * @file install-controls.test.tsx
 * @description Behavioral coverage for the pack detail-header action zone
 * (ISS-6698). This is the header control on BOTH pack shells (desktop and web,
 * via `PackDetail`) and it shipped with no tests at all.
 *
 * The load-bearing assertion is the PENDING SCOPING one. `isPending` is computed
 * from the harness alone, so a test that only asserts "the pending button is
 * disabled" is satisfied equally by the intended behavior and by a regression
 * that disables the whole row. What actually distinguishes them is the LABEL:
 * only the pending action's label swaps, so its sibling in the same harness must
 * still read "Uninstall". That is what is pinned here.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PackView } from "../../lib/pack-view";
import { createPacksContext, PacksMode } from "../../lib/packs-context";
import { InstallControls } from "../install-controls";

const DESKTOP_CONTEXT = createPacksContext(PacksMode.DesktopSolo);
const ADMIN_CONTEXT = createPacksContext(PacksMode.WebAdmin);

// Module-level per the repo's `useTopLevelRegex` convention.
const INSTALL_CLAUDE = /^Install Claude$/;
const REMOVING_TEXT = /Removing…/;

function pack(overrides: Partial<PackView> = {}): PackView {
  return {
    id: "pack-1",
    name: "release-captain",
    verified: false,
    harnesses: ["claude"],
    installedHarnesses: [],
    installedByMe: false,
    contents: [],
    ...overrides,
  };
}

describe("InstallControls (ISS-6698)", () => {
  it("offers Install for an uninstalled harness and Update + Uninstall for an installed one", async () => {
    const onInstall = vi.fn();
    const onUpdate = vi.fn();
    const onUninstall = vi.fn();
    render(
      <InstallControls
        context={DESKTOP_CONTEXT}
        onInstall={onInstall}
        onUninstall={onUninstall}
        onUpdate={onUpdate}
        pack={pack({
          harnesses: ["claude", "codex"],
          installedHarnesses: ["claude"],
        })}
      />
    );

    // The installed harness must not ALSO offer a fresh install, and the
    // uninstalled one must not offer a removal it has nothing to remove.
    expect(
      screen.queryByRole("button", { name: INSTALL_CLAUDE })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Update Codex" })
    ).not.toBeInTheDocument();

    // Each control dispatches its own action for its own harness.
    await userEvent.click(
      screen.getByRole("button", { name: "Install Codex" })
    );
    expect(onInstall).toHaveBeenCalledWith("pack-1", "codex");
    await userEvent.click(
      screen.getByRole("button", { name: "Update Claude" })
    );
    expect(onUpdate).toHaveBeenCalledWith("pack-1", "claude");
    await userEvent.click(screen.getByRole("button", { name: "Uninstall" }));
    expect(onUninstall).toHaveBeenCalledWith("pack-1", "claude");
  });

  it("swaps ONLY the pending action's label, leaving its sibling in the same harness unchanged", () => {
    // The false-green this ticket exists for: an update in flight disables both
    // of Claude's buttons, so "is disabled" cannot tell the intended behavior
    // apart from a regression that pends the whole row. The label can.
    render(
      <InstallControls
        context={DESKTOP_CONTEXT}
        pack={pack({ installedHarnesses: ["claude"] })}
        pending={{ harness: "claude", action: "update" }}
      />
    );

    expect(
      screen.getByRole("button", { name: "Updating…" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Uninstall" })
    ).toBeInTheDocument();
    expect(screen.queryByText(REMOVING_TEXT)).not.toBeInTheDocument();
  });

  it("swaps the Uninstall label the same way when removal is the pending action", () => {
    // The mirror of the case above. Without it the `uninstall` pending label is
    // only ever asserted as ABSENT, so deleting it entirely stays green while a
    // member removing a pack gets no feedback that anything is happening.
    render(
      <InstallControls
        context={DESKTOP_CONTEXT}
        pack={pack({ installedHarnesses: ["claude"] })}
        pending={{ harness: "claude", action: "uninstall" }}
      />
    );

    expect(
      screen.getByRole("button", { name: "Removing…" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Update Claude" })
    ).toBeDisabled();
  });

  it("leaves a harness with nothing in flight fully enabled", () => {
    render(
      <InstallControls
        context={DESKTOP_CONTEXT}
        pack={pack({
          harnesses: ["claude", "codex"],
          installedHarnesses: ["claude"],
        })}
        pending={{ harness: "claude", action: "update" }}
      />
    );

    expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Install Codex" })).toBeEnabled();
    // The in-flight harness is locked on BOTH of its controls: uninstalling a
    // pack whose update is mid-flight dispatches two conflicting mutations for
    // the same pack + harness. The label above proves the two actions stay
    // distinguishable; this proves neither is clickable meanwhile.
    expect(screen.getByRole("button", { name: "Uninstall" })).toBeDisabled();
  });

  it("renders no local install zone on a surface that cannot install locally", () => {
    render(
      <InstallControls
        context={ADMIN_CONTEXT}
        pack={pack({ githubUrl: "https://github.com/acme/release-captain" })}
      />
    );

    expect(
      screen.queryByRole("button", { name: INSTALL_CLAUDE })
    ).not.toBeInTheDocument();
    // The zone is gated by the capability, not by an empty render: the rest of
    // the action row is still on screen.
    expect(screen.getByRole("link", { name: "GitHub" })).toBeInTheDocument();
  });

  it("offers Distribute only when the surface manages distribution AND a handler exists", async () => {
    const onDistribute = vi.fn();
    const { unmount } = render(
      <InstallControls
        context={ADMIN_CONTEXT}
        onDistribute={onDistribute}
        pack={pack()}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "Distribute" }));
    expect(onDistribute).toHaveBeenCalledWith("pack-1");
    unmount();

    // Capability without a handler: a button that would do nothing.
    render(<InstallControls context={ADMIN_CONTEXT} pack={pack()} />);
    expect(
      screen.queryByRole("button", { name: "Distribute" })
    ).not.toBeInTheDocument();
  });

  it("hides Distribute from a surface that does not manage distribution even with a handler", () => {
    render(
      <InstallControls
        context={DESKTOP_CONTEXT}
        onDistribute={vi.fn()}
        pack={pack()}
      />
    );

    expect(
      screen.queryByRole("button", { name: "Distribute" })
    ).not.toBeInTheDocument();
  });

  it("shows the disabled Installed pill for a harness-agnostic pack the member has installed", () => {
    const { unmount } = render(
      <InstallControls
        context={DESKTOP_CONTEXT}
        pack={pack({ harnesses: [], installedByMe: true })}
      />
    );
    expect(screen.getByRole("button", { name: "Installed" })).toBeDisabled();
    unmount();

    // Not installed and no per-harness list: nothing to offer, so nothing shows.
    render(
      <InstallControls
        context={DESKTOP_CONTEXT}
        pack={pack({ harnesses: [], installedByMe: false })}
      />
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("surfaces the last mutation error instead of failing silently", () => {
    render(
      <InstallControls
        context={DESKTOP_CONTEXT}
        error="Install failed: no space left on device"
        pack={pack()}
      />
    );

    expect(
      screen.getByText("Install failed: no space left on device")
    ).toBeInTheDocument();
  });
});
