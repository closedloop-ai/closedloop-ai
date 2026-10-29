"use client";

import { OnboardingAnalyticsPageName } from "@repo/api/src/types/onboarding-analytics";
import {
  type SettingsDismissal,
  SettingsDismissMode,
} from "@repo/app/settings/v2/components/settings-dismissal";
import { usePageViewedEvent } from "@repo/app/shared/observability/use-page-viewed-event";
import {
  type SettingsSlotOverlay,
  useSettingsSlotOverlay,
} from "../settings-slot-overlay";
import { SettingsPage } from "./components/settings-page";
import { SettingsV2Root } from "./components/v2/settings-v2-root";
import {
  SettingsRoutePresentation,
  SettingsV2RouteKind,
  type SettingsV2RouteState,
} from "./settings-route-state";

export type SettingsRouteRootProps = {
  initialTab: string;
  isAdmin: boolean;
  presentation: SettingsRoutePresentation;
  v2: SettingsV2RouteState;
};

/**
 * The Settings route root (ISS-8370 D1). Mounts the v2 modal shell, EXCEPT for
 * the GitHub OAuth callback no v2 panel can complete, which still renders the
 * legacy page for that request (D3).
 *
 * That legacy fallback is not leftover gate machinery and must not be collapsed
 * with it: `docs/runbooks/settings-v2-legacy-removal-checklist.md` records the
 * legacy Settings surface with no v2 owner. ISS-10316 gave owners to the Google
 * callback, the BYO Anthropic credential and `?tab=integrations`; the GitHub
 * callback's `requires_confirmation` dialog still has none, and routing that
 * callback at a panel that cannot complete it is a dropped OAuth result.
 *
 * The dismissal mode is the host's fact, not the route file's: an intercepted
 * mount is overlay only while the slot host is really holding a surface behind
 * it, which it says by publishing {@link useSettingsSlotOverlay}.
 */
export function SettingsRouteRoot({
  initialTab,
  isAdmin,
  presentation,
  v2,
}: Readonly<SettingsRouteRootProps>) {
  const overlay = useSettingsSlotOverlay();
  // PRD-736 (ISS-10501): one view per mount, covering the full page and its
  // intercepted overlay twin — both are a Settings navigation entry.
  usePageViewedEvent(OnboardingAnalyticsPageName.Settings);

  if (v2.kind === SettingsV2RouteKind.LegacyCallback) {
    return <SettingsPage initialTab={initialTab} isAdmin={isAdmin} />;
  }
  return (
    <SettingsV2Root
      dismissal={resolveDismissal(presentation, overlay)}
      routeParams={v2.routeParams}
    />
  );
}

function resolveDismissal(
  presentation: SettingsRoutePresentation,
  overlay: SettingsSlotOverlay | null
): SettingsDismissal {
  if (presentation === SettingsRoutePresentation.Intercepted && overlay) {
    return { mode: SettingsDismissMode.Overlay, onDismiss: overlay.onDismiss };
  }
  return { mode: SettingsDismissMode.Cold };
}
