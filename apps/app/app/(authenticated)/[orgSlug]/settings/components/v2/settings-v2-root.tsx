"use client";

import { SettingsPanelHost } from "@repo/api/src/types/settings-panel";
import {
  buildSettingsPanelRoute,
  type SettingsRouteParams,
} from "@repo/api/src/types/settings-route-links";
import type { SettingsDismissal } from "@repo/app/settings/v2/components/settings-dismissal";
import { SettingsShell } from "@repo/app/settings/v2/components/settings-shell";
import { useSettingsShellCapabilities } from "@repo/app/settings/v2/hooks/use-settings-view-model";
import { DESKTOP_ONLY_SETTINGS_PANEL_PLACEHOLDERS } from "@repo/app/settings/v2/lib/settings-panel-host-availability";
import {
  assertSettingsPanelRegistryComplete,
  createSettingsPanelRegistry,
} from "@repo/app/settings/v2/lib/settings-panel-registry";
import { useSharedSettingsPanelRegistry } from "@repo/app/settings/v2/lib/use-settings-panel-registry";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { useEffect } from "react";
import { RumErrorSource } from "@/lib/datadog-rum/error-source";
import { reportNextjsError } from "@/lib/datadog-rum/report-error";
import { resolveLegacySettingsFragmentPanel } from "@/lib/settings-migration/settings-deep-link-adapters";
import {
  UNFLAGGED_WEB_SETTINGS_PANELS,
  WEB_SETTINGS_PANEL_DESCRIPTORS,
} from "./settings-v2-panels";

// The ownership assert (ISS-8370 D4): a panel package that fails to register
// fails this module's load with the missing ids named, instead of leaving a
// hole a user discovers.
assertSettingsPanelRegistryComplete(
  createSettingsPanelRegistry(WEB_SETTINGS_PANEL_DESCRIPTORS)
);

export type SettingsV2RootProps = {
  routeParams: SettingsRouteParams;
  dismissal: SettingsDismissal;
};

/**
 * Every web-owned descriptor the rendered registry receives. A module constant
 * because ISS-10244 retired the last flag any of them read, and the registry is
 * memoised on this reference.
 */
const WEB_RENDERED_PANELS = Object.freeze([
  ...UNFLAGGED_WEB_SETTINGS_PANELS,
  ...DESKTOP_ONLY_SETTINGS_PANEL_PLACEHOLDERS,
]);

/**
 * The web Settings v2 composition root (ISS-8370 M1). It reads no feature flag:
 * the route root above it is the site that mounts this tree, and the one
 * surviving leaf key (`artifact-tags`) stays read by its own hook inside
 * {@link useSharedSettingsPanelRegistry}.
 */
export function SettingsV2Root({
  routeParams,
  dismissal,
}: Readonly<SettingsV2RootProps>) {
  const registry = useSharedSettingsPanelRegistry(WEB_RENDERED_PANELS);
  const { capabilities, retry } = useSettingsShellCapabilities();
  useLegacyFragmentPanelRedirect(routeParams.returnTo);

  return (
    <SettingsShell
      capabilities={capabilities}
      dismissal={dismissal}
      host={SettingsPanelHost.Web}
      onRetryCapabilities={retry}
      registry={registry}
      reportException={reportSettingsPanelException}
      routeParams={routeParams}
    />
  );
}

/**
 * D9: a crashed panel goes where the root error boundary's own catch goes, so
 * it is the existing renderer-exception signal and not a second path.
 */
function reportSettingsPanelException(error: Error): void {
  reportNextjsError(error, { source: RumErrorSource.NextjsErrorBoundary });
}

/**
 * A bookmarked `?tab=integrations#anthropic-api-key` names a card that now
 * renders on API Keys, not on Plugins where the tab maps (ISS-10316). The
 * server never sees the fragment, so the correction runs after mount and
 * replaces the URL with the card's canonical `?panel=` link, fragment kept.
 */
function useLegacyFragmentPanelRedirect(returnTo: string | null): void {
  const { replace } = useNavigation();
  const buildOrgPath = useOrgPath();

  useEffect(() => {
    const location = globalThis.location;
    if (location === undefined) {
      return;
    }
    const panel = resolveLegacySettingsFragmentPanel(
      location.search,
      location.hash
    );
    if (panel === null) {
      return;
    }
    replace(
      `${buildOrgPath(buildSettingsPanelRoute({ panel, returnTo }))}${location.hash}`
    );
  }, [buildOrgPath, replace, returnTo]);
}
