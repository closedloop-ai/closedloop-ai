import {
  SettingsPanelId,
  SettingsPanelIntent,
} from "@repo/api/src/types/settings-panel";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import InterceptedSettingsPage from "../../@settings/(.)settings/page";
import SettingsPage from "../page";
import { SettingsRoutePage } from "../settings-route-page";
import {
  SettingsRoutePresentation,
  SettingsV2RouteKind,
} from "../settings-route-state";
import {
  SettingsIntegrationCallbackParam,
  SettingsTab,
} from "../settings-tabs";

const { authMock, routeRootMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  routeRootMock: vi.fn(),
}));

vi.mock("@repo/auth/server", () => ({ auth: authMock }));

vi.mock("../settings-route-root", () => ({
  SettingsRouteRoot: (props: unknown) => {
    routeRootMock(props);
    return <div data-testid="settings-route-root" />;
  },
}));

type Params = Record<string, string | string[]>;

async function renderRoute(
  params: Params,
  presentation: SettingsRoutePresentation = SettingsRoutePresentation.Full
) {
  render(
    await SettingsRoutePage({
      presentation,
      searchParams: Promise.resolve(params),
    })
  );
  return routeRootMock.mock.calls[0]?.[0];
}

/**
 * ISS-8370 D3 — what the server computes for the v2 tree, executed through the
 * real route module. The legacy `initialTab` contract beside it is pinned by
 * `page.test.tsx`, unchanged; these cases assert the additive half.
 */
describe("SettingsRoutePage", () => {
  beforeEach(() => {
    authMock.mockReset();
    authMock.mockResolvedValue({ has: () => false });
    routeRootMock.mockReset();
  });

  it("hands the shell a ?panel= link as parsed, intent included", async () => {
    const props = await renderRoute({
      intent: SettingsPanelIntent.Invite,
      panel: SettingsPanelId.Members,
    });

    expect(props.v2).toEqual({
      kind: SettingsV2RouteKind.Shell,
      routeParams: {
        intent: SettingsPanelIntent.Invite,
        panel: SettingsPanelId.Members,
        requestedPanel: SettingsPanelId.Members,
        returnTo: null,
      },
    });
  });

  it("opens Organization General for a legacy ?tab=organization link", async () => {
    const props = await renderRoute({ tab: SettingsTab.Organization });

    expect(props.v2.routeParams.panel).toBe(
      SettingsPanelId.OrganizationGeneral
    );
    // ...while the legacy half still lands on its own tab for the same request.
    expect(props.initialTab).toBe(SettingsTab.Organization);
  });

  it("opens Plugins for a Linear callback", async () => {
    const props = await renderRoute({
      [SettingsIntegrationCallbackParam.Linear]: "connected",
    });

    expect(props.v2.routeParams.panel).toBe(SettingsPanelId.Plugins);
  });

  it("opens Plugins for a Google Drive callback, which has a v2 owner since ISS-10316", async () => {
    const props = await renderRoute({
      [SettingsIntegrationCallbackParam.Google]: "error",
    });

    expect(props.v2.routeParams.panel).toBe(SettingsPanelId.Plugins);
  });

  it("routes a ?github= callback to the legacy page under v2 (D3)", async () => {
    const props = await renderRoute({
      [SettingsIntegrationCallbackParam.GitHub]: "error",
      code: "x",
    });

    expect(props.v2).toEqual({ kind: SettingsV2RouteKind.LegacyCallback });
    expect(props.initialTab).toBe(SettingsTab.Integrations);
  });

  it("keeps a plain visit a plain visit, so the shell's default rule decides", async () => {
    const props = await renderRoute({});

    expect(props.v2.routeParams.panel).toBeNull();
    expect(props.v2.routeParams.requestedPanel).toBeNull();
  });

  it("leaves an unrecognised ?panel= as the unknown link it is, not a default visit", async () => {
    const props = await renderRoute({ panel: "billing" });

    expect(props.v2.routeParams.panel).toBeNull();
    expect(props.v2.routeParams.requestedPanel).toBe("billing");
  });

  it("passes the presentation the route file stated", async () => {
    const full = await renderRoute({}, SettingsRoutePresentation.Full);
    expect(full.presentation).toBe(SettingsRoutePresentation.Full);

    routeRootMock.mockReset();
    const intercepted = await renderRoute(
      {},
      SettingsRoutePresentation.Intercepted
    );
    expect(intercepted.presentation).toBe(
      SettingsRoutePresentation.Intercepted
    );
  });

  it("is what the full page route file renders, as the full presentation", async () => {
    render(await SettingsPage({ searchParams: Promise.resolve({}) }));

    expect(routeRootMock).toHaveBeenCalledWith(
      expect.objectContaining({
        presentation: SettingsRoutePresentation.Full,
      })
    );
  });

  it("is what the intercepted route file renders, as the intercepted presentation", async () => {
    render(
      await InterceptedSettingsPage({ searchParams: Promise.resolve({}) })
    );

    expect(routeRootMock).toHaveBeenCalledWith(
      expect.objectContaining({
        presentation: SettingsRoutePresentation.Intercepted,
      })
    );
  });
});
