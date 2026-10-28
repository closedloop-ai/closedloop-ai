/**
 * Desktop app-shell: the Settings route (ISS-8370 D6). Split out of
 * `app-shell-routing.test.tsx`; this file owns the modal host in `App.tsx` —
 * that `#/settings` presents the Settings modal over the last nav page and is
 * never mounted as a nav page of its own — driven through the real shell.
 */
import {
  SettingsActorRole,
  SettingsActorRoleStatus,
} from "@repo/api/src/types/settings-actor-role";
import {
  SettingsPanelId,
  SettingsPanelIntent,
} from "@repo/api/src/types/settings-panel";
import { projectSettingsViewModel } from "@repo/api/src/types/settings-view-model";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  findTopbarCurrentPage,
  installDesktopApi,
  renderDesktopApp,
  setupAppShellSuite,
} from "./app-shell-harness";

const SHELL_TEST_ID = "settings-shell";
const CLOSE_SETTINGS_NAME = "Close settings";

vi.mock("../components/UpdateBanner", () => ({
  UpdateBanner: () => null,
}));
// The modal's capabilities come off two cloud reads through the api port;
// this suite is about the shell's mount, so they resolve as a member.
vi.mock("@repo/app/settings/v2/hooks/use-settings-view-model", () => ({
  useSettingsShellCapabilities: () => ({
    capabilities: projectSettingsViewModel({
      resolution: {
        role: SettingsActorRole.Member,
        status: SettingsActorRoleStatus.Resolved,
      },
      staleSessionRole: false,
    }).capabilities,
    retry: vi.fn(),
  }),
}));
// The panel body is a marker that echoes the `intent` the shell hands it, so a
// deep link's params can be seen arriving through the modal.
vi.mock(
  "@repo/app/settings/v2/panels/connected-devices/connected-devices-panel",
  () => ({
    ConnectedDevicesPanel: ({ intent }: { intent?: string | null }) => (
      <div data-intent={intent ?? ""} data-testid="connected-devices-body">
        devices
      </div>
    ),
  })
);

function activePanel(navId: string): HTMLElement | null {
  return document.querySelector(
    `[data-nav-panel="${navId}"][data-nav-panel-state="active"]`
  );
}

function closeLinkHref(): string | null {
  return within(screen.getByTestId(SHELL_TEST_ID))
    .getByRole("link", { name: CLOSE_SETTINGS_NAME })
    .getAttribute("href");
}

describe("App shell Settings route (ISS-8370 D6)", () => {
  setupAppShellSuite();

  it("#/settings opens the modal over the page the user was on, keeps that page mounted and inert, and never mounts Settings as a page", async () => {
    installDesktopApi({});
    await renderDesktopApp("#/sessions");
    // The BODY, not just the breadcrumb: the page must have committed before
    // Settings opens over it, or "still mounted" below proves nothing.
    expect(
      await screen.findByRole("link", { name: "Shell Active Session" })
    ).toBeDefined();

    window.location.hash = "#/settings";

    const shell = await screen.findByTestId(SHELL_TEST_ID);
    // The desktop default panel (D8): the first panel this host offers.
    expect(
      within(shell)
        .getByRole("link", { name: "Connected Devices" })
        .getAttribute("aria-current")
    ).toBe("page");
    expect(
      await within(shell).findByTestId("connected-devices-body")
    ).toBeDefined();
    // Settings is the modal, so it gets no keep-alive nav panel of its own.
    expect(document.querySelector('[data-nav-panel="settings"]')).toBeNull();
    // The page underneath is still the committed nav view, and the Radix
    // dialog has made it inert rather than unmounting it.
    const sessions = activePanel("sessions");
    expect(sessions).not.toBeNull();
    expect(
      within(screen.getByTestId("desktop-content-viewport")).queryByText(
        "Shell Active Session"
      )
    ).not.toBeNull();
    expect(sessions?.closest('[aria-hidden="true"]')).not.toBeNull();
    // Cold mode with `returnTo` defaulted to the page underneath.
    expect(closeLinkHref()).toBe("#/sessions");

    fireEvent.keyDown(shell, { key: "Escape" });

    await waitFor(() => expect(window.location.hash).toBe("#/sessions"));
    await waitFor(() => expect(screen.queryByTestId(SHELL_TEST_ID)).toBeNull());
    expect(activePanel("sessions")?.closest('[aria-hidden="true"]')).toBeNull();
    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    expect(document.querySelector('[data-nav-panel="settings"]')).toBeNull();
  });

  it("Settings opened from a session detail closes back to that detail, while the page beneath the modal is the last nav page", async () => {
    installDesktopApi({});
    await renderDesktopApp("#/sessions");
    expect(
      await screen.findByRole("link", { name: "Shell Active Session" })
    ).toBeDefined();

    window.location.hash = "#/sessions/s-active";
    expect(await findTopbarCurrentPage("Shell Active Session")).toBeDefined();

    window.location.hash = "#/settings";

    const shell = await screen.findByTestId(SHELL_TEST_ID);
    // The return target is the DETAIL the user left, not its list.
    expect(closeLinkHref()).toBe("#/sessions/s-active");
    // What sits beneath the modal is still the last NAV page: detail views are
    // route-driven, never keep-alive, so the list is what the map holds.
    expect(activePanel("sessions")).not.toBeNull();
    expect(document.querySelector('[data-nav-panel="settings"]')).toBeNull();

    fireEvent.keyDown(shell, { key: "Escape" });

    await waitFor(() =>
      expect(window.location.hash).toBe("#/sessions/s-active")
    );
    expect(await findTopbarCurrentPage("Shell Active Session")).toBeDefined();
  });

  it("a cold #/settings launch has no page behind it and closes to the default nav", async () => {
    installDesktopApi({});
    await renderDesktopApp("#/settings");

    const shell = await screen.findByTestId(SHELL_TEST_ID);
    expect(closeLinkHref()).toBe("#/dashboard");
    expect(document.querySelector('[data-nav-panel="settings"]')).toBeNull();

    fireEvent.keyDown(shell, { key: "Escape" });

    await waitFor(() => expect(window.location.hash).toBe("#/dashboard"));
    expect(await findTopbarCurrentPage("Dashboard")).toBeDefined();
  });

  it("a native panel link (#/settings?panel=connected-devices&intent=sync-policy) opens the modal on Connected Devices with its intent, over the page the user was on", async () => {
    installDesktopApi({});
    await renderDesktopApp("#/sessions");
    expect(
      await screen.findByRole("link", { name: "Shell Active Session" })
    ).toBeDefined();

    window.location.hash = `#/settings?panel=${SettingsPanelId.ConnectedDevices}&intent=${SettingsPanelIntent.SyncPolicy}`;

    const shell = await screen.findByTestId(SHELL_TEST_ID);
    expect(
      within(shell)
        .getByRole("link", { name: "Connected Devices" })
        .getAttribute("aria-current")
    ).toBe("page");
    const body = await within(shell).findByTestId("connected-devices-body");
    expect(body.getAttribute("data-intent")).toBe(
      SettingsPanelIntent.SyncPolicy
    );
    // ISS-8353's interim full-page route is retired: the link is the modal
    // over the page the user was on, never a Settings page.
    expect(document.querySelector('[data-nav-panel="settings"]')).toBeNull();
    expect(activePanel("sessions")).not.toBeNull();
    expect(closeLinkHref()).toBe("#/sessions");
  });
});
