import {
  DEFAULT_SETTINGS_PANEL_ID,
  SETTINGS_PANEL_IDS,
  SETTINGS_PANEL_LABEL,
  SettingsPanelHost,
  SettingsPanelId,
  SettingsPanelIntent,
} from "@repo/api/src/types/settings-panel";
import { parseSettingsRouteParams } from "@repo/api/src/types/settings-route";
import {
  createMemoryNavigation,
  type MemoryNavigation,
} from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { createSettingsPanelRegistry } from "../../lib/settings-panel-registry";
import {
  fixturePanel,
  grantRead,
} from "../../test-fixtures/settings-panel-fixtures";
import {
  type SettingsDismissal,
  SettingsDismissMode,
} from "../settings-dismissal";
import { SettingsShell } from "../settings-shell";

/**
 * ISS-8979 — the ISS-8362 deep-link contract survives modal presentation.
 *
 * ISS-8362 is DONE and shipped, so this is a compatibility surface: every link
 * that opened a panel as a page must open the same panel as a modal, the URL
 * must stay in step as the user moves between panels, and a link arriving cold
 * must have a defined surface to close back to.
 */

const COLD: SettingsDismissal = { mode: SettingsDismissMode.Cold };

const CLOSE_SETTINGS_NAME = /^Close settings$/;

/**
 * Every id in the contract, so a panel added to `SETTINGS_PANEL_IDS` without a
 * deep link that reaches it fails here rather than in production.
 */
const registry = createSettingsPanelRegistry(
  SETTINGS_PANEL_IDS.map((id) => fixturePanel(id))
);

const capabilities = grantRead(...SETTINGS_PANEL_IDS);

function newNav(initialPath = "/settings"): MemoryNavigation {
  return createMemoryNavigation({ initialPath, orgSlug: "acme" });
}

function renderDeepLink(
  search: Record<string, string>,
  nav: MemoryNavigation = newNav()
) {
  return render(
    <NavigationProvider adapter={nav.adapter}>
      <SettingsShell
        capabilities={capabilities}
        dismissal={COLD}
        host={SettingsPanelHost.Web}
        registry={registry}
        routeParams={parseSettingsRouteParams(search)}
      />
    </NavigationProvider>
  );
}

describe("settings modal deep links (ISS-8979)", () => {
  it.each(SETTINGS_PANEL_IDS)(
    "opens the %s panel from its deep link, now inside the modal",
    (panelId) => {
      const view = renderDeepLink({ panel: panelId });

      // The panel the link named is the one that mounted…
      expect(screen.getByTestId(`panel-body-${panelId}`)).toBeInTheDocument();
      // …inside the dialog, not as a page region…
      expect(screen.getByTestId("settings-shell")).toHaveAttribute(
        "role",
        "dialog"
      );
      // …and the rail agrees about which one is current.
      expect(
        screen.getByRole("link", {
          name: new RegExp(`^${SETTINGS_PANEL_LABEL[panelId]}$`),
        })
      ).toHaveAttribute("aria-current", "page");

      view.unmount();
    }
  );

  it("lands on the contract's default panel when the link names none", () => {
    renderDeepLink({});

    expect(
      screen.getByTestId(`panel-body-${DEFAULT_SETTINGS_PANEL_ID}`)
    ).toBeInTheDocument();
  });

  it("carries a secondary intent through to the panel", () => {
    // ISS-8362 AC3's typed Members-with-invite link. The panel receives the
    // intent, so an older build that does not understand one still renders.
    const intentRegistry = createSettingsPanelRegistry([
      fixturePanel(SettingsPanelId.Members, {
        Panel: ({ intent }) => <div data-testid="members-intent">{intent}</div>,
      }),
    ]);
    render(
      <NavigationProvider adapter={newNav().adapter}>
        <SettingsShell
          capabilities={grantRead(SettingsPanelId.Members)}
          dismissal={COLD}
          host={SettingsPanelHost.Web}
          registry={intentRegistry}
          routeParams={parseSettingsRouteParams({
            intent: SettingsPanelIntent.Invite,
            panel: SettingsPanelId.Members,
          })}
        />
      </NavigationProvider>
    );

    expect(screen.getByTestId("members-intent")).toHaveTextContent(
      SettingsPanelIntent.Invite
    );
  });

  it("keeps the URL in step as the user moves between panels inside the modal", async () => {
    const nav = newNav();
    const user = userEvent.setup();
    render(
      <NavigationProvider adapter={nav.adapter}>
        <SettingsShell
          capabilities={capabilities}
          dismissal={COLD}
          host={SettingsPanelHost.Web}
          registry={registry}
          routeParams={parseSettingsRouteParams({
            panel: SettingsPanelId.Profile,
          })}
        />
      </NavigationProvider>
    );

    await user.click(
      screen.getByRole("link", {
        name: new RegExp(`^${SETTINGS_PANEL_LABEL[SettingsPanelId.Members]}$`),
      })
    );

    // A link copied mid-session reopens the same panel, which a local-state
    // panel selection could not offer.
    await waitFor(() => {
      expect(nav.getCurrentHref()).toBe("/acme/settings?panel=members");
    });
  });

  it("preserves the origin surface across an in-modal panel change", async () => {
    const nav = newNav();
    const user = userEvent.setup();
    const shellAt = (search: Record<string, string>) => (
      <NavigationProvider adapter={nav.adapter}>
        <SettingsShell
          capabilities={capabilities}
          dismissal={COLD}
          host={SettingsPanelHost.Web}
          registry={registry}
          routeParams={parseSettingsRouteParams(search)}
        />
      </NavigationProvider>
    );
    const view = render(
      shellAt({ panel: SettingsPanelId.Profile, returnTo: "/acme/branches" })
    );

    await user.click(
      screen.getByRole("link", {
        name: new RegExp(`^${SETTINGS_PANEL_LABEL[SettingsPanelId.Members]}$`),
      })
    );
    await waitFor(() => {
      expect(nav.getCurrentHref()).toContain("panel=members");
    });

    // Re-render from the URL that click actually produced, then read the CLOSE
    // control — a panel change that dropped `returnTo` would silently degrade
    // the close target to the dashboard mid-session.
    view.rerender(
      shellAt(
        Object.fromEntries(
          new URLSearchParams(nav.getCurrentHref().split("?")[1] ?? "")
        )
      )
    );
    expect(
      screen.getByRole("link", { name: CLOSE_SETTINGS_NAME })
    ).toHaveAttribute("href", "/acme/branches");
  });

  it("gives a cold deep link a defined surface to close back to", () => {
    // ISS-8979 AC: a link arriving with nothing behind it resolves to the
    // dashboard rather than an empty backdrop. ISS-8370's close-to-Dashboard is
    // exactly this case, not a competing rule.
    renderDeepLink({ panel: SettingsPanelId.Members });

    expect(
      screen.getByRole("link", { name: CLOSE_SETTINGS_NAME })
    ).toHaveAttribute("href", "/acme/dashboard");
  });

  it("leaves a browser history entry on a cold dismiss and none on an overlay dismiss", async () => {
    const user = userEvent.setup();

    const coldNav = newNav();
    const coldView = renderDeepLink(
      { panel: SettingsPanelId.Members },
      coldNav
    );
    const coldBefore = coldNav.getHistory().length;
    await user.click(screen.getByRole("link", { name: CLOSE_SETTINGS_NAME }));
    await waitFor(() => {
      expect(coldNav.getHistory().length).toBe(coldBefore + 1);
    });
    coldView.unmount();

    // The overlay case dismisses in place, so Back still means "the step before
    // Settings was opened" rather than "reopen Settings".
    const overlayNav = newNav("/branches");
    function OverlayHost() {
      const [open, setOpen] = useState(true);
      return (
        <NavigationProvider adapter={overlayNav.adapter}>
          {open ? (
            <SettingsShell
              capabilities={capabilities}
              dismissal={{
                mode: SettingsDismissMode.Overlay,
                onDismiss: () => setOpen(false),
              }}
              host={SettingsPanelHost.Web}
              registry={registry}
              routeParams={parseSettingsRouteParams({
                panel: SettingsPanelId.Members,
              })}
            />
          ) : null}
        </NavigationProvider>
      );
    }
    render(<OverlayHost />);
    const overlayBefore = overlayNav.getHistory().length;
    await user.click(screen.getByRole("button", { name: CLOSE_SETTINGS_NAME }));
    await waitFor(() => {
      expect(screen.queryByTestId("settings-shell")).not.toBeInTheDocument();
    });
    expect(overlayNav.getHistory().length).toBe(overlayBefore);
  });
});
