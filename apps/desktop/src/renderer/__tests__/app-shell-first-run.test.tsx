/**
 * Desktop app-shell: a TRUE first run (ISS-10855).
 *
 * A fresh install opens on the Dashboard with the guided-onboarding welcome
 * modal over it. The shell mounts on the first frame and the modal sits on top;
 * nothing replaces the shell. This is the production-wiring case for that
 * composition: the real `DesktopNavigationApp` over the real
 * `DesktopAppCoreProvider`, with an EMPTY first-run store and a signed-out
 * device (the harness stub exposes no auth bridge, so auth settles signed out).
 */
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardOnboardedStorageKey } from "../components/dashboard/dashboard-storage-keys";
import { renderDesktopApp, setupAppShellSuite } from "./app-shell-harness";

vi.mock("../components/UpdateBanner", () => ({
  UpdateBanner: () => null,
}));

/** The welcome step's heading, which also names the guided-onboarding dialog. */
const WELCOME_HEADING = "Discover how you (and your team) build with AI.";

describe("App shell on a true first run", () => {
  setupAppShellSuite();

  beforeEach(() => {
    // Opt out of BOTH returning-install seeds: `setupAppShellSuite` writes the
    // first-run latch in its own `beforeEach`, and the lane-wide
    // `renderer-returning-install-setup.ts` writes it before every case. This
    // `beforeEach` runs after both, so removing the key here is what makes the
    // store genuinely empty of first-run state.
    window.localStorage.removeItem(dashboardOnboardedStorageKey);
  });

  it("mounts the shell with the guided welcome dialog open over it", async () => {
    renderDesktopApp("");

    expect(
      await screen.findByRole("dialog", { name: WELCOME_HEADING })
    ).toBeDefined();
    // By element, not by role: the open modal `aria-hidden`s everything outside
    // itself, so the shell's landmark leaves the accessibility tree while it is
    // mounted and on screen. A takeover that REPLACED the shell would leave no
    // `main` at all.
    expect(document.querySelector("main")).not.toBeNull();
  });
});
