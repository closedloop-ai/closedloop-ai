import { parseSettingsRouteParams } from "@repo/api/src/types/settings-route";
import type { SettingsRouteParams } from "@repo/api/src/types/settings-route-links";
import {
  type LegacySettingsDeepLink,
  resolveV2SettingsDeepLink,
  SettingsDeepLinkSource,
} from "@/lib/settings-migration/settings-deep-link-adapters";

/** Which route file rendered Settings: the full page, or its intercepted twin. */
export const SettingsRoutePresentation = {
  Full: "full",
  Intercepted: "intercepted",
} as const;

export type SettingsRoutePresentation =
  (typeof SettingsRoutePresentation)[keyof typeof SettingsRoutePresentation];

export const SettingsV2RouteKind = {
  /** Mount the v2 shell with these params. */
  Shell: "shell",
  /**
   * An integration OAuth callback no v2 panel can complete (`?github=` since
   * ISS-10316 gave `?google=` to Plugins). The v2 tree renders the LEGACY page
   * for this request, callback and all — ISS-8380 designed that outcome, and
   * ISS-8370 D3 records it.
   */
  LegacyCallback: "legacy-callback",
} as const;

export type SettingsV2RouteKind =
  (typeof SettingsV2RouteKind)[keyof typeof SettingsV2RouteKind];

export type SettingsV2RouteState =
  | { kind: typeof SettingsV2RouteKind.Shell; routeParams: SettingsRouteParams }
  | { kind: typeof SettingsV2RouteKind.LegacyCallback };

/**
 * What the v2 tree does with a Settings request (ISS-8370 D3). `?panel=` is
 * parsed as today and wins outright. Without it, the legacy vocabulary is
 * honoured through ISS-8380's adapter: a `?tab=` naming a successor and a
 * `?linear=` or `?google=` callback open their panel; a callback with no v2 owner falls back
 * to the legacy page; and a link that named nothing resolvable stays a plain
 * visit, so the shell's own default — and D8's host rule — decide where it
 * lands.
 */
export function resolveSettingsV2RouteState(
  params: LegacySettingsDeepLink & { panel?: string | string[] }
): SettingsV2RouteState {
  const parsed = parseSettingsRouteParams(params);
  if (parsed.requestedPanel !== null) {
    return { kind: SettingsV2RouteKind.Shell, routeParams: parsed };
  }

  const deepLink = resolveV2SettingsDeepLink(params);
  if (deepLink.source === SettingsDeepLinkSource.UnownedCallback) {
    return { kind: SettingsV2RouteKind.LegacyCallback };
  }
  if (deepLink.source === SettingsDeepLinkSource.Default) {
    return { kind: SettingsV2RouteKind.Shell, routeParams: parsed };
  }
  return {
    kind: SettingsV2RouteKind.Shell,
    routeParams: {
      ...parsed,
      intent: deepLink.intent,
      panel: deepLink.panel,
      requestedPanel: deepLink.panel,
    },
  };
}
