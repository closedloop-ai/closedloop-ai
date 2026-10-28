import { OrgAdminRole } from "@repo/api/src/types/org-admin-role";
import {
  SettingsPanelId,
  SettingsPanelIntent,
} from "@repo/api/src/types/settings-panel";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRedirectSearchParams } from "@/lib/app-route-redirects";
import SettingsRoutePage from "../page";
import {
  SettingsRoutePresentation,
  SettingsV2RouteKind,
  type SettingsV2RouteState,
} from "../settings-route-state";
import {
  SettingsIntegrationCallbackParam,
  SettingsTab,
} from "../settings-tabs";

const { authMock, settingsRouteRootMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  settingsRouteRootMock: vi.fn(),
}));

vi.mock("@repo/auth/server", () => ({
  auth: authMock,
}));

vi.mock("../settings-route-root", () => ({
  SettingsRouteRoot: settingsRouteRootMock,
}));

type Params = {
  tab?: string | string[];
  panel?: string | string[];
  intent?: string | string[];
  returnTo?: string | string[];
  github?: string | string[];
  google?: string | string[];
  linear?: string | string[];
};

function renderPage(params: Params, isAdmin: boolean) {
  authMock.mockResolvedValue({
    has: ({ role }: { role: string }) =>
      isAdmin && (role === "org:admin" || role === "org:owner"),
  });
  return SettingsRoutePage({ searchParams: Promise.resolve(params) });
}

describe("Settings route page — initial tab resolution", () => {
  beforeEach(() => {
    authMock.mockReset();
    settingsRouteRootMock.mockReset();
    settingsRouteRootMock.mockImplementation(
      ({
        initialTab,
        v2,
      }: {
        initialTab: string;
        v2: SettingsV2RouteState;
      }) => (
        <div
          data-initial-tab={initialTab}
          data-open-v2-route={String(v2.kind === SettingsV2RouteKind.Shell)}
          data-testid="settings-page"
          data-v2-intent={
            v2.kind === SettingsV2RouteKind.Shell ? v2.routeParams.intent : ""
          }
          data-v2-panel={
            v2.kind === SettingsV2RouteKind.Shell
              ? (v2.routeParams.panel ?? "")
              : ""
          }
          data-v2-requested-panel={
            v2.kind === SettingsV2RouteKind.Shell
              ? (v2.routeParams.requestedPanel ?? "")
              : ""
          }
          data-v2-return-to={
            v2.kind === SettingsV2RouteKind.Shell
              ? (v2.routeParams.returnTo ?? "")
              : ""
          }
        />
      )
    );
  });

  it("falls back to Profile when a stale ?tab=admin deep link is requested (FEA-3975)", async () => {
    // The Admin tab was removed, so its old id is no longer allowlisted even
    // for an admin. A bookmarked ?tab=admin must degrade to the default tab
    // rather than open a tab that no longer renders.
    render(await renderPage({ tab: "admin" }, true));

    expect(settingsRouteRootMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialTab: SettingsTab.Profile,
        isAdmin: true,
        presentation: SettingsRoutePresentation.Full,
      }),
      undefined
    );
    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.Profile
    );
  });

  it("honors a still-valid deep link (?tab=integrations)", async () => {
    render(await renderPage({ tab: SettingsTab.Integrations }, false));

    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.Integrations
    );
  });

  it("keeps the admin-only custom-fields tab reachable for admins", async () => {
    render(await renderPage({ tab: SettingsTab.CustomFields }, true));
    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.CustomFields
    );
  });

  // The gate asks Clerk about one role at a time, and every other case here
  // hands it BOTH privileged roles at once. An owner who is not also an admin
  // is therefore the only caller a gate that checked `org:admin` alone would
  // silently demote to member.
  it("keeps the admin-only custom-fields tab reachable for an org owner", async () => {
    authMock.mockResolvedValue({
      has: ({ role }: { role: string }) => role === OrgAdminRole.Owner,
    });

    render(
      await SettingsRoutePage({
        searchParams: Promise.resolve({ tab: SettingsTab.CustomFields }),
      })
    );

    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.CustomFields
    );
  });

  it("hides the admin-only custom-fields deep link from members", async () => {
    render(await renderPage({ tab: SettingsTab.CustomFields }, false));
    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.Profile
    );
  });

  it("keeps the admin-only compliance tab reachable for admins (FEA-4029)", async () => {
    render(await renderPage({ tab: SettingsTab.Compliance }, true));
    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.Compliance
    );
  });

  it("hides the admin-only compliance deep link from members (FEA-4029)", async () => {
    render(await renderPage({ tab: SettingsTab.Compliance }, false));
    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.Profile
    );
  });

  it("forces the integrations tab on an OAuth callback regardless of ?tab", async () => {
    render(await renderPage({ tab: "admin", github: "connected" }, true));

    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.Integrations
    );
  });

  it("ignores an empty callback param, which is no callback at all", async () => {
    render(
      await renderPage({ tab: SettingsTab.Organization, github: "" }, false)
    );

    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.Organization
    );
  });
});

/**
 * closedloop-ai-stage, PR #4501: a retired route's successor query is only half
 * a contract — this page is free to IGNORE the tab it is sent, dropping any tab
 * outside the caller's allowlist and falling back to Profile with nothing on
 * screen saying why. That coupling is executed here rather than left to review:
 * the ISS-5011 `/organization` forward's REAL query is driven through the REAL
 * destination page, so the day the Organization tab goes admin-only or behind a
 * flag, this fails instead of the forward silently recreating the broken promise
 * it exists to keep.
 */
describe("Settings route page — ISS-5011 /organization forward lands on its tab", () => {
  beforeEach(() => {
    authMock.mockReset();
    settingsRouteRootMock.mockReset();
    settingsRouteRootMock.mockImplementation(
      ({ initialTab }: { initialTab: string }) => (
        <div data-initial-tab={initialTab} data-testid="settings-page" />
      )
    );
  });

  it("honors the forward's tab for a plain member, not just an admin", async () => {
    const overlay = resolveRedirectSearchParams("/acme/organization", "acme");

    render(await renderPage({ tab: overlay?.set.tab }, false));

    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.Organization
    );
  });

  // whitlockk, PR #4501: this is the state the proxy now prevents by stripping the
  // callback keys off the forward. Pinned from the destination's side so the
  // precedence that made stripping necessary cannot change unnoticed.
  it("still lets a real integration callback outrank an explicit ?tab", async () => {
    const overlay = resolveRedirectSearchParams("/acme/organization", "acme");

    render(
      await renderPage(
        {
          tab: overlay?.set.tab,
          [SettingsIntegrationCallbackParam.GitHub]: "bogus",
        },
        false
      )
    );

    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.Integrations
    );
    // ...which is exactly why the forward must clear those keys.
    expect(overlay?.remove).toContain(SettingsIntegrationCallbackParam.GitHub);
  });
});

/**
 * ISS-8380 AC2 (rollback): the additive `?panel=` alias, executed through the
 * real page rather than through the adapter alone, so deleting the call site
 * fails a test instead of leaving the adapter green with no caller.
 *
 * The alias is the LOWEST-precedence input and is allowlisted like any other
 * tab, which is what keeps it from widening what a member can open.
 */
describe("Settings route page — ISS-8380 v2 ?panel= rollback alias", () => {
  beforeEach(() => {
    authMock.mockReset();
    settingsRouteRootMock.mockReset();
    settingsRouteRootMock.mockImplementation(
      ({ initialTab }: { initialTab: string }) => (
        <div data-initial-tab={initialTab} data-testid="settings-page" />
      )
    );
  });

  it("lands a rolled-back v2 Members bookmark on the tab that administers members", async () => {
    render(await renderPage({ panel: SettingsPanelId.Members }, false));

    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.Organization
    );
  });

  it("lets this tree's own ?tab= outrank the successor vocabulary", async () => {
    render(
      await renderPage(
        { tab: SettingsTab.ApiKeys, panel: SettingsPanelId.Members },
        false
      )
    );

    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.ApiKeys
    );
  });

  it("keeps an OAuth callback ahead of the alias", async () => {
    render(
      await renderPage(
        { panel: SettingsPanelId.ApiKeys, github: "connected" },
        false
      )
    );

    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.Integrations
    );
  });

  it("does not let the alias open an admin tab for a member", async () => {
    render(await renderPage({ panel: SettingsPanelId.Compliance }, false));

    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.Profile
    );
  });

  it("opens that same admin tab for an admin", async () => {
    render(await renderPage({ panel: SettingsPanelId.Compliance }, true));

    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.Compliance
    );
  });

  it("falls back to the default tab for an unrecognized panel", async () => {
    render(await renderPage({ panel: "not-a-panel" }, true));

    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.Profile
    );
  });

  it("reads a repeated ?panel= at position 0, as this page reads its own ?tab=", async () => {
    // `?panel=&panel=tags`. The alias reader used to skip the blank and open
    // Tags, while this page's own `getRequestedTab` and the v2
    // `parseSettingsRouteParams` both take `[0]` and answer the default — so
    // one URL opened two different screens depending on which reader saw it.
    render(await renderPage({ panel: ["", SettingsPanelId.Tags] }, true));

    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.Profile
    );
  });

  it("still honours a repeated ?panel= whose first entry is the real one", async () => {
    render(await renderPage({ panel: [SettingsPanelId.Tags, ""] }, true));

    expect(screen.getByTestId("settings-page")).toHaveAttribute(
      "data-initial-tab",
      SettingsTab.Tags
    );
  });
});

describe("Settings route page — native Settings v2 panel route", () => {
  beforeEach(() => {
    authMock.mockReset();
    settingsRouteRootMock.mockReset();
    settingsRouteRootMock.mockImplementation(
      ({
        initialTab,
        v2,
      }: {
        initialTab: string;
        v2: SettingsV2RouteState;
      }) => (
        <div
          data-initial-tab={initialTab}
          data-open-v2-route={String(v2.kind === SettingsV2RouteKind.Shell)}
          data-testid="settings-page"
          data-v2-intent={
            v2.kind === SettingsV2RouteKind.Shell ? v2.routeParams.intent : ""
          }
          data-v2-panel={
            v2.kind === SettingsV2RouteKind.Shell
              ? (v2.routeParams.panel ?? "")
              : ""
          }
          data-v2-requested-panel={
            v2.kind === SettingsV2RouteKind.Shell
              ? (v2.routeParams.requestedPanel ?? "")
              : ""
          }
          data-v2-return-to={
            v2.kind === SettingsV2RouteKind.Shell
              ? (v2.routeParams.returnTo ?? "")
              : ""
          }
        />
      )
    );
  });

  it("passes the Connected Devices sync-policy deep link to the v2 route branch", async () => {
    render(
      await renderPage(
        {
          intent: SettingsPanelIntent.SyncPolicy,
          panel: SettingsPanelId.ConnectedDevices,
          returnTo: "/acme/dashboard",
        },
        false
      )
    );

    const route = screen.getByTestId("settings-page");
    expect(route).toHaveAttribute("data-open-v2-route", "true");
    expect(route).toHaveAttribute(
      "data-v2-panel",
      SettingsPanelId.ConnectedDevices
    );
    expect(route).toHaveAttribute(
      "data-v2-requested-panel",
      SettingsPanelId.ConnectedDevices
    );
    expect(route).toHaveAttribute(
      "data-v2-intent",
      SettingsPanelIntent.SyncPolicy
    );
    expect(route).toHaveAttribute("data-v2-return-to", "/acme/dashboard");
  });

  it("hands legacy tab-only visits to the v2 successor when the v2 tree is selected", async () => {
    render(await renderPage({ tab: SettingsTab.ApiKeys }, false));

    const route = screen.getByTestId("settings-page");
    expect(route).toHaveAttribute("data-open-v2-route", "true");
    expect(route).toHaveAttribute("data-v2-panel", SettingsPanelId.ApiKeys);
    expect(route).toHaveAttribute("data-v2-intent", SettingsPanelIntent.View);
  });
});
