import {
  SettingsActorRole,
  SettingsActorRoleStatus,
} from "@repo/api/src/types/settings-actor-role";
import {
  SETTINGS_PANEL_LABEL,
  SettingsPanelId,
} from "@repo/api/src/types/settings-panel";
import { parseSettingsRouteParams } from "@repo/api/src/types/settings-route";
import { projectSettingsViewModel } from "@repo/api/src/types/settings-view-model";
import { SettingsDismissMode } from "@repo/app/settings/v2/components/settings-dismissal";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DesktopSettingsV2Root } from "../desktop-settings-v2-root";

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

// The body reads two cloud endpoints through the api port; this suite is about
// the root's composition, so the body is a marker.
vi.mock(
  "@repo/app/settings/v2/panels/connected-devices/connected-devices-panel",
  () => ({
    ConnectedDevicesPanel: () => (
      <div data-testid="connected-devices-body">devices</div>
    ),
  })
);

// The Desktop App body drives four main-process control blocks over
// `window.desktopApi`; this suite is about the root's composition, so the body
// is a marker.
vi.mock("../panels/desktop-app-panel", () => ({
  DesktopAppPanel: () => <div data-testid="desktop-app-body">desktop app</div>,
}));

const COLD = { mode: SettingsDismissMode.Cold } as const;

// ISS-10244 retired `settings-device-panels`, so no leaf key decides whether
// desktop offers a panel any more; `artifact-tags` only withholds Tags.
function renderRoot(search: Record<string, string>): void {
  const nav = createMemoryNavigation({ initialPath: "/sessions" });
  render(
    <NavigationProvider adapter={nav.adapter}>
      <FeatureFlagAdapterProvider
        adapter={{
          useFeatureFlagEnabled: () => false,
        }}
      >
        <DesktopSettingsV2Root
          dismissal={COLD}
          routeParams={parseSettingsRouteParams(search)}
        />
      </FeatureFlagAdapterProvider>
    </NavigationProvider>
  );
}

/** The nav entries the shell offers, minus the `unavailable` recovery link. */
function navLinkNames(): string[] {
  return screen
    .getAllByRole("link")
    .map((link) => link.textContent?.trim() ?? "")
    .filter((name) => name.length > 0 && !name.startsWith("Open "));
}

function panelState(): string | null {
  return (
    document
      .querySelector("[data-settings-panel-state]")
      ?.getAttribute("data-settings-panel-state") ?? null
  );
}

/**
 * ISS-8370 M1 — the desktop composition root. Importing it above already ran
 * the host-scoped ownership assert over the eight shared descriptors and the
 * web-only list; these cases drive the rendered composition through the real
 * shell on the desktop host.
 */
describe("DesktopSettingsV2Root", () => {
  it("lands a plain visit on Connected Devices, the first panel desktop offers (D8)", async () => {
    renderRoot({});

    expect(await screen.findByTestId("connected-devices-body")).toBeTruthy();
  });

  it("keeps the unavailable screen for a link that names Profile", () => {
    renderRoot({ panel: SettingsPanelId.Profile });

    expect(panelState()).toBe("unavailable");
    expect(
      screen
        .getByRole("link", { name: "Open Connected Devices" })
        .getAttribute("href")
    ).toBe("/settings?panel=connected-devices");
  });
  /**
   * The developer and governance packages used to be leaf-gated, so closing
   * every leaf key left desktop with nothing to offer. ISS-10244 retired those
   * gates, and API Keys, Other Labs, Custom Fields and Compliance are all
   * offered on BOTH hosts. Pinned so a future regating has to state itself here.
   *
   * ENTERED THROUGH A LABS PANEL, and that is a consequence of this change
   * rather than a convenience. Labs is a COLLAPSED disclosure that opens only
   * when the active panel is inside it. While `settings-device-panels` was
   * closed, desktop had no User-group panel, so a plain visit landed on a Labs
   * panel and the group was already open. Retiring that gate registers Connected
   * Devices, which is what a plain visit now lands on — so Labs is collapsed
   * there and its entries are legitimately out of the accessibility tree. A deep
   * link is how this host reaches them now.
   *
   * NAMES the panels rather than asserting only that the landing was not
   * `unavailable`: "something rendered" stays green if the retirement registered
   * the wrong package, or none.
   *
   * Tags is the negative on the same selector, and it is load-bearing: it is the
   * one governance descriptor still gated, by `artifact-tags`, which this
   * retirement did NOT touch. Without it, a change that registered every
   * descriptor unconditionally would satisfy both positives.
   */
  /**
   * ISS-10286 — Labs → Desktop App, UNCONDITIONAL.
   *
   * The PostHog gate this suite used to drive both poles of is retired
   * (operator ruling, 2026-09-17). The panel is the only home the
   * machine-local controls have, and the case the ruling names — a guest on an
   * offline desktop — never receives a PostHog assignment, so the closed pole
   * was the state every one of those users would have been left in. The
   * closed-pole case retired with the contract it asserted.
   *
   * The adapter above answers `false` to every key, so this case ALSO proves
   * the panel no longer depends on one: re-introducing any gate here turns both
   * assertions red.
   *
   * The nav assertion is the half a resolution-only test would miss — a
   * registered panel that never appears in navigation is reachable solely by
   * deep link, which is how the controls got stranded in the first place.
   */
  it("mounts Desktop App and lists it in Labs with every flag closed", async () => {
    renderRoot({ panel: SettingsPanelId.DesktopApp });

    expect(await screen.findByTestId("desktop-app-body")).toBeTruthy();
    expect(navLinkNames()).toContain(
      SETTINGS_PANEL_LABEL[SettingsPanelId.DesktopApp]
    );
  });

  it("offers the ungated developer and governance panels when every leaf key is closed", () => {
    renderRoot({ panel: SettingsPanelId.ApiKeys });

    const names = navLinkNames();
    expect(names).toContain(SETTINGS_PANEL_LABEL[SettingsPanelId.ApiKeys]);
    expect(names).toContain(SETTINGS_PANEL_LABEL[SettingsPanelId.CustomFields]);
    expect(names).not.toContain(SETTINGS_PANEL_LABEL[SettingsPanelId.Tags]);
    expect(panelState()).not.toBe("unavailable");
  });
});
