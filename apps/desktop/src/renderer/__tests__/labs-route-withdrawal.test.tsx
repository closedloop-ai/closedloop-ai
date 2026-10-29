/**
 * ISS-9731 — a Labs destination whose OWN gate is closed withdraws to the shared
 * panel instead of rendering a breadcrumb over a blank body.
 *
 * `#/help` resolved the route, painted the title, and then rendered nothing,
 * because the view self-guarded to `null`. Unavailable and
 * empty are different states, and the user could not tell them apart. These
 * cases drive the REAL shell at the REAL hash, so deleting the route gate or
 * restoring a self-guard fails here.
 *
 * MOUNTED AT THE ROUTE, NOT NAVIGATED TO IT. ISS-9715 found the pre-existing
 * `#/audit` coverage vacuous: it set the hash and then awaited a locator that
 * resolved against the pre-navigation DOM, so it documented the bug as intended
 * while proving nothing. `renderDesktopApp` sets the hash BEFORE the first
 * render, so every assertion below is against the route under test.
 */

import { DESKTOP_LABS_ROUTE_WITHDRAWAL_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY } from "../../shared/desktop-docs-help-flag";
import {
  installDesktopApi,
  renderDesktopApp,
  setupAppShellSuite,
} from "./app-shell-harness";

vi.mock("../components/UpdateBanner", () => ({
  UpdateBanner: () => null,
}));
// The body is mocked to a marker: this suite is about WHETHER the shell mounts
// it, not what it renders. A marker also makes "the view rendered" assertable
// without stubbing the docs-help IPC surface.
vi.mock("../components/help/help-view", () => ({
  HelpView: () => <div data-testid="route-body:help" />,
}));

setupAppShellSuite();

/** The surfaces ISS-9731 newly routes through the withdrawal panel. */
const NEWLY_WITHDRAWN = [
  {
    hash: "#/help",
    key: DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY,
    bodyTestId: "route-body:help",
    turnedOff: "Help is turned off",
    docsPointer: true,
  },
] as const;

/** The shipped label, spelled independently of the constant under test. */
const VIEW_ONLINE_NAME = /View online/i;

describe("ISS-9731 Labs route withdrawal", () => {
  for (const surface of NEWLY_WITHDRAWN) {
    it(`withdraws ${surface.hash} to the panel when its gate is closed and the key is on`, async () => {
      installDesktopApi({
        labsNav: true,
        assignmentFlags: {
          [surface.key]: false,
          [DESKTOP_LABS_ROUTE_WITHDRAWAL_FEATURE_FLAG_KEY]: true,
        },
      });

      renderDesktopApp(surface.hash);

      // The panel NAMES the destination the user asked for, so the hash, the
      // title and the body all tell the same story.
      expect(await screen.findByText(surface.turnedOff)).toBeTruthy();
      expect(screen.queryByTestId(surface.bodyTestId)).toBeNull();
      // The withheld route carries the pointer its own destination owns.
      const docsLink = screen.queryByRole("link", { name: VIEW_ONLINE_NAME });
      if (surface.docsPointer) {
        expect(docsLink).not.toBeNull();
        expect(docsLink?.getAttribute("href")).toContain("closedloop.ai/docs");
      } else {
        expect(docsLink).toBeNull();
      }
    });

    it(`mounts ${surface.hash} normally once its gate is open`, async () => {
      // The counterfactual for the case above: with the gate OPEN the body
      // renders and the panel does not, so the withdrawal assertion cannot be
      // satisfied by a shell that renders the panel unconditionally — or by one
      // that renders nothing at all.
      installDesktopApi({
        labsNav: true,
        assignmentFlags: {
          [surface.key]: true,
          [DESKTOP_LABS_ROUTE_WITHDRAWAL_FEATURE_FLAG_KEY]: true,
        },
      });

      renderDesktopApp(surface.hash);

      expect(await screen.findByTestId(surface.bodyTestId)).toBeTruthy();
      expect(screen.queryByText(surface.turnedOff)).toBeNull();
    });

    it(`leaves ${surface.hash} blank while the rollout key is closed`, async () => {
      // Closed-by-default: the key is what newly renders UI here, so with it off
      // the route must be byte-identical to the self-guard it replaced — the
      // route resolves, and neither the body nor the panel is shown.
      installDesktopApi({
        labsNav: true,
        assignmentFlags: {
          [surface.key]: false,
          [DESKTOP_LABS_ROUTE_WITHDRAWAL_FEATURE_FLAG_KEY]: false,
        },
      });

      renderDesktopApp(surface.hash);

      // Wait for the SETTLED state. Absence of the body and the panel is also
      // satisfied by the `LabsPageHold` skeleton, which every Labs destination
      // shows while the assignment is still in flight — `labsNavOn` is the raw
      // flag, so that window predates this change and is not what the key
      // governs. What the flag-OFF arm must guarantee is where the route COMES
      // TO REST, so this waits the skeleton out instead of asserting it never
      // appeared (code review on this PR raised the distinction).
      await waitFor(() => {
        expect(screen.queryByRole("status")).toBeNull();
      });
      expect(screen.queryByTestId(surface.bodyTestId)).toBeNull();
      expect(screen.queryByText(surface.turnedOff)).toBeNull();
    });
  }

  it("keeps Agents withdrawing with the rollout key CLOSED (ISS-5310 is not regressed)", async () => {
    // Agents already withdrew before this key existed, so the key must not be
    // able to take that away. This is the case a flag covering every surface
    // would fail.
    installDesktopApi({
      labsNav: true,
      agentsNav: false,
      assignmentFlags: {
        [DESKTOP_LABS_ROUTE_WITHDRAWAL_FEATURE_FLAG_KEY]: false,
      },
    });

    renderDesktopApp("#/agents");

    expect(await screen.findByText("Agents is turned off")).toBeTruthy();
    // ISS-9731: only Help owns a docs pointer, so no other panel may grow one.
    expect(screen.queryByRole("link", { name: VIEW_ONLINE_NAME })).toBeNull();
  });
});
