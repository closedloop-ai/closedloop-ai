import { SettingsPanelId } from "@repo/api/src/types/settings-panel";
import { parseSettingsRouteParams } from "@repo/api/src/types/settings-route";
import { SettingsDismissMode } from "@repo/app/settings/v2/components/settings-dismissal";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsSlotOverlayProvider } from "../../settings-slot-overlay";
import { SettingsRouteRoot } from "../settings-route-root";
import {
  SettingsRoutePresentation,
  SettingsV2RouteKind,
  type SettingsV2RouteState,
} from "../settings-route-state";

const { settingsPageMock, settingsV2RootMock } = vi.hoisted(() => ({
  settingsPageMock: vi.fn(),
  settingsV2RootMock: vi.fn(),
}));

vi.mock("../components/settings-page", () => ({
  SettingsPage: (props: { initialTab: string; isAdmin: boolean }) => {
    settingsPageMock(props);
    return <div data-testid="legacy-settings-page" />;
  },
}));

vi.mock("../components/v2/settings-v2-root", () => ({
  SettingsV2Root: (props: unknown) => {
    settingsV2RootMock(props);
    return <div data-testid="settings-v2-root" />;
  },
}));

const SHELL: SettingsV2RouteState = {
  kind: SettingsV2RouteKind.Shell,
  routeParams: parseSettingsRouteParams({ panel: SettingsPanelId.Members }),
};

function renderRoot(input: {
  presentation: SettingsRoutePresentation;
  v2?: SettingsV2RouteState;
  onDismiss?: () => void;
}) {
  const root = (
    <SettingsRouteRoot
      initialTab="profile"
      isAdmin={false}
      presentation={input.presentation}
      v2={input.v2 ?? SHELL}
    />
  );
  if (input.onDismiss) {
    return render(
      <SettingsSlotOverlayProvider onDismiss={input.onDismiss}>
        {root}
      </SettingsSlotOverlayProvider>
    );
  }
  return render(root);
}

/**
 * ISS-8370 D1/D2 — the Settings route root: which shell each presentation
 * mounts, and the one request shape that still falls back to the legacy page.
 */
describe("SettingsRouteRoot", () => {
  beforeEach(() => {
    settingsPageMock.mockReset();
    settingsV2RootMock.mockReset();
  });

  it("mounts the v2 shell cold on the full page", () => {
    renderRoot({ presentation: SettingsRoutePresentation.Full });

    expect(screen.getByTestId("settings-v2-root")).toBeInTheDocument();
    expect(settingsV2RootMock).toHaveBeenCalledWith({
      dismissal: { mode: SettingsDismissMode.Cold },
      routeParams: SHELL.routeParams,
    });
    expect(settingsPageMock).not.toHaveBeenCalled();
  });

  it("mounts the v2 shell as an overlay when intercepted over a live surface", () => {
    const onDismiss = vi.fn();

    renderRoot({
      onDismiss,
      presentation: SettingsRoutePresentation.Intercepted,
    });

    expect(settingsV2RootMock).toHaveBeenCalledWith({
      dismissal: { mode: SettingsDismissMode.Overlay, onDismiss },
      routeParams: SHELL.routeParams,
    });
  });

  it("mounts the v2 shell cold when intercepted with nothing behind it", () => {
    // The slot host publishes no overlay when the page underneath IS Settings.
    renderRoot({ presentation: SettingsRoutePresentation.Intercepted });

    expect(settingsV2RootMock).toHaveBeenCalledWith({
      dismissal: { mode: SettingsDismissMode.Cold },
      routeParams: SHELL.routeParams,
    });
  });

  it("renders the legacy page for an OAuth callback no v2 panel can complete (D3)", () => {
    renderRoot({
      presentation: SettingsRoutePresentation.Full,
      v2: { kind: SettingsV2RouteKind.LegacyCallback },
    });

    expect(screen.getByTestId("legacy-settings-page")).toBeInTheDocument();
    expect(settingsV2RootMock).not.toHaveBeenCalled();
  });
});
