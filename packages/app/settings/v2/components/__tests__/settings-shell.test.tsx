import {
  SETTINGS_PANEL_LABEL,
  SettingsActorCapabilityStatus,
  SettingsPanelCapability,
  SettingsPanelHost,
  SettingsPanelId,
} from "@repo/api/src/types/settings-panel";
import { parseSettingsRouteParams } from "@repo/api/src/types/settings-route";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { lazy } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSettingsPanelRegistry,
  type SettingsPanelComponent,
} from "../../lib/settings-panel-registry";
import {
  fixturePanel,
  grantRead,
} from "../../test-fixtures/settings-panel-fixtures";
import {
  type SettingsDismissal,
  SettingsDismissMode,
} from "../settings-dismissal";
import { SettingsShell, type SettingsShellProps } from "../settings-shell";

const UNKNOWN_PANEL_COPY = /is not a settings panel/;
const FORBIDDEN_COPY = /don't have access/;
const PLACEHOLDER_PANEL_COPY = /That panel/;

const registry = createSettingsPanelRegistry([
  fixturePanel("profile"),
  fixturePanel("members"),
  fixturePanel("desktop-app", {
    hosts: [SettingsPanelHost.Desktop],
  }),
]);

/**
 * The mode these ISS-8362-era cases were written under: a deep link straight
 * into Settings with nothing mounted behind it, whose close control is still a
 * real navigation. The overlay mode has its own cases below.
 */
const COLD: SettingsDismissal = { mode: SettingsDismissMode.Cold };

function renderShell(
  search: Record<string, string>,
  overrides: Partial<SettingsShellProps> = {}
): void {
  const nav = createMemoryNavigation({ initialPath: "/", orgSlug: "acme" });
  render(
    <NavigationProvider adapter={nav.adapter}>
      <SettingsShell
        capabilities={grantRead("profile", "members")}
        dismissal={COLD}
        host={SettingsPanelHost.Web}
        registry={registry}
        routeParams={parseSettingsRouteParams(search)}
        {...overrides}
      />
    </NavigationProvider>
  );
}

function panelState(): string | null {
  return (
    document
      .querySelector("[data-settings-panel-state]")
      ?.getAttribute("data-settings-panel-state") ?? null
  );
}

describe("settings shell", () => {
  // Restored here rather than at the end of each body: a body-tail
  // `vi.restoreAllMocks()` never runs when an assertion above it throws, so
  // the `console.error` spy would leak into every later test in this file and
  // swallow the React warnings they depend on.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mounts the panel the deep link asked for, from the registry", () => {
    renderShell({ panel: "members" });

    expect(screen.getByTestId("panel-body-members")).toBeInTheDocument();
    expect(panelState()).toBeNull();
    expect(screen.getByRole("link", { name: "Members" })).toHaveAttribute(
      "aria-current",
      "page"
    );
  });

  it("keeps Settings usable when the link names a panel that does not exist", () => {
    renderShell({ panel: "integrations" });

    expect(screen.getByTestId("settings-shell")).toBeInTheDocument();
    expect(panelState()).toBe("unknown");
    expect(screen.queryByTestId("panel-body-members")).not.toBeInTheDocument();
    expect(screen.getByText(UNKNOWN_PANEL_COPY)).toBeVisible();
    expect(screen.getByRole("link", { name: "Open Profile" })).toHaveAttribute(
      "href",
      "/acme/settings?panel=profile"
    );
  });

  it("says forbidden and unavailable differently from unknown", () => {
    renderShell({ panel: "members" }, { capabilities: grantRead("profile") });
    expect(panelState()).toBe("forbidden");
    expect(screen.getByText("You don't have access to Members")).toBeVisible();
    expect(screen.queryByText(UNKNOWN_PANEL_COPY)).not.toBeInTheDocument();

    cleanup();
    renderShell(
      { panel: "desktop-app" },
      { capabilities: grantRead("profile", "desktop-app") }
    );
    expect(
      screen.getByText(
        `${SETTINGS_PANEL_LABEL[SettingsPanelId.DesktopApp]} isn't available here`
      )
    ).toBeVisible();
  });

  it("opens Connected Devices for a link naming the retired Local Compute Targets id", () => {
    renderShell(
      { panel: "local-compute-targets" },
      {
        capabilities: grantRead("profile", "connected-devices"),
        registry: createSettingsPanelRegistry([
          fixturePanel("profile"),
          fixturePanel("connected-devices"),
        ]),
      }
    );

    expect(
      screen.getByTestId("panel-body-connected-devices")
    ).toBeInTheDocument();
    expect(panelState()).toBeNull();
  });

  it("shows a pending capability read as loading, never as a denial", () => {
    renderShell(
      { panel: "members" },
      { capabilities: { status: SettingsActorCapabilityStatus.Pending } }
    );

    expect(panelState()).toBe("loading");
    expect(screen.queryByText(FORBIDDEN_COPY)).not.toBeInTheDocument();
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
  });

  it("keeps a panel whose capability read failed visible in the nav", () => {
    const onRetryCapabilities = vi.fn();
    renderShell(
      { panel: "members" },
      {
        capabilities: {
          grants: { members: [SettingsPanelCapability.Read] },
          status: SettingsActorCapabilityStatus.Ready,
          unreadable: ["members"],
        },
        onRetryCapabilities,
      }
    );

    expect(panelState()).toBe("capability-error");
    expect(
      document.querySelector('[data-settings-nav-state="capability-error"]')
    ).toHaveTextContent("Members");
    expect(
      screen.getByText("We couldn't check your access to Members")
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  it("closes to the requested in-app origin verbatim, and to the dashboard otherwise", () => {
    // A web producer reads its own slug-carrying path out of the router, so
    // that is what `returnTo` carries and the shell must NOT join the slug a
    // second time — doing so produced `/acme/acme/branches`.
    renderShell({ panel: "members", returnTo: "/acme/branches" });
    expect(
      screen.getByRole("link", { name: "Close settings" })
    ).toHaveAttribute("href", "/acme/branches");

    cleanup();
    renderShell({ panel: "members", returnTo: "https://evil.example" });
    expect(
      screen.getByRole("link", { name: "Close settings" })
    ).toHaveAttribute("href", "/acme/dashboard");
  });

  it("contains a panel body that throws instead of blanking Settings", () => {
    const exploding = createSettingsPanelRegistry([
      fixturePanel("profile"),
      fixturePanel("members", {
        Panel: () => {
          throw new Error("panel exploded");
        },
      }),
    ]);
    const reportException = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    renderShell({ panel: "members" }, { registry: exploding, reportException });

    expect(panelState()).toBe("render-error");
    expect(screen.getByTestId("settings-shell")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Profile" })).toBeVisible();
    expect(reportException).toHaveBeenCalled();

    // No in-place retry is offered. The failure this boundary exists for is a
    // rejected lazy chunk, whose payload React caches as rejected forever — a
    // button that only cleared boundary state would re-render the same lazy,
    // throw the same cached error, and land back here. The nav is the recovery.
    expect(
      screen.queryByRole("button", { name: "Try again" })
    ).not.toBeInTheDocument();
  });

  it("cannot recover a rejected lazy panel by mounting it again", async () => {
    // Pins the REASON the retry action is absent, not just its absence: React's
    // `lazyInitializer` parks a rejected payload in its terminal state and
    // re-throws it without calling the loader again. A second mount of the same
    // lazy component is therefore still a throw, and the loader runs once —
    // which is exactly what a "Try again" that only cleared boundary state
    // would have done.
    const load = vi.fn(() =>
      Promise.reject(new Error("Failed to fetch dynamically imported module"))
    );
    const LazyPanel = lazy(
      load as () => Promise<{ default: SettingsPanelComponent }>
    );
    const lazyRegistry = createSettingsPanelRegistry([
      fixturePanel("profile"),
      fixturePanel("members", { Panel: LazyPanel }),
    ]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    renderShell({ panel: "members" }, { registry: lazyRegistry });
    await waitFor(() => {
      expect(panelState()).toBe("render-error");
    });

    cleanup();
    renderShell({ panel: "members" }, { registry: lazyRegistry });
    await waitFor(() => {
      expect(panelState()).toBe("render-error");
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Profile" })).toBeVisible();
  });
  it("names the panel that was actually denied on a plain visit", () => {
    renderShell({}, { capabilities: grantRead("members") });

    expect(panelState()).toBe("forbidden");
    expect(screen.getByText("You don't have access to Profile")).toBeVisible();
    expect(screen.queryByText(PLACEHOLDER_PANEL_COPY)).not.toBeInTheDocument();
  });

  it("opens the Labs group when the deep link lands inside it", () => {
    const labsRegistry = createSettingsPanelRegistry([
      fixturePanel("profile"),
      fixturePanel("tags"),
    ]);
    renderShell(
      { panel: "tags" },
      { capabilities: grantRead("profile", "tags"), registry: labsRegistry }
    );
    expect(screen.getByRole("link", { name: "Tags" })).toBeVisible();

    cleanup();
    renderShell(
      { panel: "profile" },
      { capabilities: grantRead("profile", "tags"), registry: labsRegistry }
    );
    expect(
      screen.queryByRole("link", {
        name: SETTINGS_PANEL_LABEL[SettingsPanelId.Tags],
      })
    ).not.toBeInTheDocument();
  });

  it("opens Labs when the active panel moves into it without a remount", () => {
    // The route change that follows a Labs deep link does NOT remount the
    // shell, and Radix reads `defaultOpen` once. Remounting between the two
    // routes — which the case above does — cannot see that: the group would be
    // re-seeded open every time and a stuck-closed Labs would still pass.
    const labsRegistry = createSettingsPanelRegistry([
      fixturePanel("profile"),
      fixturePanel("tags"),
    ]);
    const capabilities = grantRead("profile", "tags");
    const nav = createMemoryNavigation({ initialPath: "/", orgSlug: "acme" });
    const shell = (panel: string) => (
      <NavigationProvider adapter={nav.adapter}>
        <SettingsShell
          capabilities={capabilities}
          dismissal={COLD}
          host={SettingsPanelHost.Web}
          registry={labsRegistry}
          routeParams={parseSettingsRouteParams({ panel })}
        />
      </NavigationProvider>
    );

    const view = render(shell("profile"));
    // Radix unmounts a closed group's content, so the absent entry is the
    // collapsed state rather than a missing registration.
    expect(
      screen.queryByText(SETTINGS_PANEL_LABEL[SettingsPanelId.Tags])
    ).not.toBeInTheDocument();

    view.rerender(shell("tags"));
    expect(screen.getByRole("link", { name: "Tags" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Tags" })).toHaveAttribute(
      "aria-current",
      "page"
    );
  });

  it("opens Labs when the capability read resolves onto a Labs deep link", () => {
    // The first render of a Labs deep link happens while capabilities are still
    // pending, so no panel is active yet and a seeded-open group is seeded
    // CLOSED. When the read resolves the shell rerenders in place, and Radix
    // ignores the changed default.
    const labsRegistry = createSettingsPanelRegistry([
      fixturePanel("profile"),
      fixturePanel("tags"),
    ]);
    const nav = createMemoryNavigation({ initialPath: "/", orgSlug: "acme" });
    const shell = (capabilities: SettingsShellProps["capabilities"]) => (
      <NavigationProvider adapter={nav.adapter}>
        <SettingsShell
          capabilities={capabilities}
          dismissal={COLD}
          host={SettingsPanelHost.Web}
          registry={labsRegistry}
          routeParams={parseSettingsRouteParams({ panel: "tags" })}
        />
      </NavigationProvider>
    );

    const view = render(
      shell({ status: SettingsActorCapabilityStatus.Pending })
    );
    expect(
      screen.queryByText(SETTINGS_PANEL_LABEL[SettingsPanelId.Tags])
    ).not.toBeInTheDocument();

    view.rerender(shell(grantRead("profile", "tags")));
    expect(screen.getByRole("link", { name: "Tags" })).toBeVisible();
  });

  it("clears a crashed panel's error screen once another panel is opened", () => {
    const exploding = createSettingsPanelRegistry([
      fixturePanel("profile"),
      fixturePanel("members", {
        Panel: () => {
          throw new Error("panel exploded");
        },
      }),
    ]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const nav = createMemoryNavigation({ initialPath: "/", orgSlug: "acme" });
    const view = render(
      <NavigationProvider adapter={nav.adapter}>
        <SettingsShell
          capabilities={grantRead("profile", "members")}
          dismissal={COLD}
          host={SettingsPanelHost.Web}
          registry={exploding}
          routeParams={parseSettingsRouteParams({ panel: "members" })}
        />
      </NavigationProvider>
    );
    expect(panelState()).toBe("render-error");

    view.rerender(
      <NavigationProvider adapter={nav.adapter}>
        <SettingsShell
          capabilities={grantRead("profile", "members")}
          dismissal={COLD}
          host={SettingsPanelHost.Web}
          registry={exploding}
          routeParams={parseSettingsRouteParams({ panel: "profile" })}
        />
      </NavigationProvider>
    );
    expect(panelState()).toBeNull();
    expect(screen.getByTestId("panel-body-profile")).toBeInTheDocument();
  });
  it("keeps panel labels legible while their capability read is pending", () => {
    renderShell(
      { panel: "members" },
      { capabilities: { status: SettingsActorCapabilityStatus.Pending } }
    );

    const pendingRows = document.querySelectorAll(
      '[data-settings-nav-state="pending"]'
    );
    expect(pendingRows.length).toBeGreaterThan(0);
    expect([...pendingRows].map((row) => row.textContent)).toContain("Members");
    expect(
      screen.queryByRole("link", {
        name: SETTINGS_PANEL_LABEL[SettingsPanelId.Members],
      })
    ).not.toBeInTheDocument();
  });

  it("states a surface-wide capability failure once, not on every nav row", () => {
    renderShell(
      { panel: "members" },
      { capabilities: { status: SettingsActorCapabilityStatus.Error } }
    );
    expect(screen.queryAllByText("(access unknown)")).toHaveLength(0);

    cleanup();
    renderShell(
      { panel: "members" },
      {
        capabilities: {
          grants: { profile: [SettingsPanelCapability.Read] },
          status: SettingsActorCapabilityStatus.Ready,
          unreadable: ["members"],
        },
      }
    );
    expect(screen.getAllByText("(access unknown)")).toHaveLength(1);
  });
});
