import { SettingsPanelHost } from "@repo/api/src/types/settings-panel";
import type { SettingsRouteParams } from "@repo/api/src/types/settings-route-links";
import type { SettingsDismissal } from "@repo/app/settings/v2/components/settings-dismissal";
import {
  SettingsShell,
  type SettingsShellProps,
} from "@repo/app/settings/v2/components/settings-shell";
import { useSettingsShellCapabilities } from "@repo/app/settings/v2/hooks/use-settings-view-model";
import {
  WEB_ONLY_SETTINGS_PANEL_IDS,
  WEB_ONLY_SETTINGS_PANEL_PLACEHOLDERS,
} from "@repo/app/settings/v2/lib/settings-panel-host-availability";
import {
  assertSettingsPanelRegistryCompleteForHost,
  createSettingsPanelRegistry,
} from "@repo/app/settings/v2/lib/settings-panel-registry";
import {
  SHARED_SETTINGS_PANEL_DESCRIPTORS,
  useSharedSettingsPanelRegistry,
} from "@repo/app/settings/v2/lib/use-settings-panel-registry";
import { DESKTOP_APP_SETTINGS_PANEL } from "./panels/desktop-app-settings-panel";

// The host-scoped ownership assert (ISS-8370 D4): the eight shared descriptors,
// plus this shell's own Desktop App panel (ISS-10286), plus the explicit
// web-only list cover all twelve ids, or this module fails to load with the gap
// named.
assertSettingsPanelRegistryCompleteForHost(
  createSettingsPanelRegistry([
    ...SHARED_SETTINGS_PANEL_DESCRIPTORS,
    DESKTOP_APP_SETTINGS_PANEL,
  ]),
  SettingsPanelHost.Desktop,
  WEB_ONLY_SETTINGS_PANEL_IDS
);

/**
 * What this shell renders on top of the shared set: the web-only placeholders,
 * plus its own Desktop App panel. UNCONDITIONAL (operator ruling, 2026-09-17 —
 * "should be retired enabled for everyone so we handle the default guest
 * desktop offline case"): the panel is the only home the machine-local controls
 * have, and a guest on an offline desktop never receives a PostHog assignment,
 * so any gate here is a gate that never opens for the user who needs it most.
 */
const DESKTOP_RENDERED_PANELS = Object.freeze([
  ...WEB_ONLY_SETTINGS_PANEL_PLACEHOLDERS,
  DESKTOP_APP_SETTINGS_PANEL,
]);

export type DesktopSettingsV2RootProps = {
  routeParams: SettingsRouteParams;
  dismissal: SettingsDismissal;
  /** The renderer OTel runtime's exception path, handed in by the mount. */
  reportException?: SettingsShellProps["reportException"];
};

/**
 * The desktop Settings v2 composition root (ISS-8370 M1), mounted by the shell
 * through `DesktopSettingsModal` (M4); it reads no feature flag, because the
 * site that mounts it is the one that chose this tree. The rendered registry is
 * the shared set plus the web-only placeholders and this host's own Desktop App
 * panel: the three web-owned panels cannot be imported here, and the
 * placeholders are what make a link naming one resolve `unavailable` through
 * the host axis — which D8 keeps a plain visit clear of.
 */
export function DesktopSettingsV2Root({
  routeParams,
  dismissal,
  reportException,
}: Readonly<DesktopSettingsV2RootProps>) {
  const registry = useSharedSettingsPanelRegistry(DESKTOP_RENDERED_PANELS);
  const { capabilities, retry } = useSettingsShellCapabilities();

  return (
    <SettingsShell
      capabilities={capabilities}
      dismissal={dismissal}
      host={SettingsPanelHost.Desktop}
      onRetryCapabilities={retry}
      registry={registry}
      reportException={reportException}
      routeParams={routeParams}
    />
  );
}
