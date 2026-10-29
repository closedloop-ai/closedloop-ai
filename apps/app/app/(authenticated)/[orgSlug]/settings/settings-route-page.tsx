import { SETTINGS_PANEL_PARAM } from "@repo/api/src/types/settings-panel";
import { hasAdminRole } from "@repo/app/shared/lib/role-utils";
import { auth } from "@repo/auth/server";
import { resolveLegacyTabForV2Panel } from "@/lib/settings-migration/settings-deep-link-adapters";
import { SettingsRouteRoot } from "./settings-route-root";
import {
  resolveSettingsV2RouteState,
  type SettingsRoutePresentation,
} from "./settings-route-state";
import {
  ADMIN_SETTINGS_TABS,
  BASE_SETTINGS_TABS,
  DEFAULT_SETTINGS_TAB,
  SETTINGS_INTEGRATION_CALLBACK_PARAMS,
  type SettingsIntegrationCallbackParam,
  SettingsTab,
} from "./settings-tabs";

// The callback keys are derived from the shared const rather than re-listed, so
// adding one to `SETTINGS_INTEGRATION_CALLBACK_PARAMS` teaches this page's
// searchParams type and its detection in the same edit.
export type SettingsPageProperties = {
  searchParams: Promise<
    { tab?: string | string[]; panel?: string | string[] } & Partial<
      Record<SettingsIntegrationCallbackParam, string | string[]>
    >
  >;
};

export type SettingsRoutePageProperties = SettingsPageProperties & {
  presentation: SettingsRoutePresentation;
};

/**
 * The one Settings server component behind both route files (ISS-8370 D2): the
 * full page and its intercepted twin compute the same request state and hand
 * the client root both trees. What it computes for LEGACY is byte-for-byte what
 * `page.tsx` computed before the split; the v2 half is additive.
 */
export async function SettingsRoutePage({
  searchParams,
  presentation,
}: Readonly<SettingsRoutePageProperties>) {
  const [{ has }, params] = await Promise.all([auth(), searchParams]);
  const isAdmin = hasAdminRole(has);
  const requestedTab = getRequestedTab(params.tab);
  const allowedTabs = isAdmin
    ? [...BASE_SETTINGS_TABS, ...ADMIN_SETTINGS_TABS]
    : BASE_SETTINGS_TABS;
  // Any integration OAuth callback (github / google / linear) returns the
  // admin to /settings with a status query param. Force the integrations
  // tab so the relevant card is mounted to surface the updated status,
  // toast, or (PLN-634) the different-account confirmation dialog —
  // otherwise the admin lands on the default `profile` tab and misses it.
  const isIntegrationCallback = SETTINGS_INTEGRATION_CALLBACK_PARAMS.some(
    (key) => hasSearchParamValue(params[key])
  );
  const initialTab = resolveInitialTab({
    isIntegrationCallback,
    requestedTab,
    aliasedTab: resolveLegacyTabForV2Panel(params[SETTINGS_PANEL_PARAM]),
    allowedTabs,
  });

  return (
    <SettingsRouteRoot
      initialTab={initialTab}
      isAdmin={isAdmin}
      presentation={presentation}
      v2={resolveSettingsV2RouteState(params)}
    />
  );
}

function getRequestedTab(tab: string | string[] | undefined): string | null {
  if (typeof tab === "string") {
    return tab;
  }

  if (Array.isArray(tab)) {
    return tab[0] ?? null;
  }

  return null;
}

/**
 * `aliasedTab` is the ISS-8380 rollback path: the tab a v2 `?panel=` deep link
 * maps onto, so a bookmark made while the v2 Settings tree was serving still
 * lands on the subject matter it named after a rollback.
 *
 * It ranks BELOW both existing inputs and is additive only. An OAuth callback
 * still outranks everything, and this tree's own `?tab=` still beats an alias
 * for the same request — a legacy link arriving on the legacy tree must not be
 * re-routed by the successor vocabulary. The alias is subject to the same
 * `allowedTabs` check, so it cannot open an admin tab for a member.
 */
function resolveInitialTab(input: {
  isIntegrationCallback: boolean;
  requestedTab: string | null;
  aliasedTab: string | null;
  allowedTabs: readonly string[];
}): string {
  if (input.isIntegrationCallback) {
    return SettingsTab.Integrations;
  }
  if (input.requestedTab && input.allowedTabs.includes(input.requestedTab)) {
    return input.requestedTab;
  }
  if (input.aliasedTab && input.allowedTabs.includes(input.aliasedTab)) {
    return input.aliasedTab;
  }
  return DEFAULT_SETTINGS_TAB;
}

/**
 * Whether a callback query key carries a real value.
 *
 * Repeated params arrive as an array, and an empty string is not a callback —
 * only a nonempty value means an OAuth round trip actually happened and should
 * outrank an explicit `?tab=`.
 */
function hasSearchParamValue(value: string | string[] | undefined): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => entry.length > 0);
  }
  return Boolean(value);
}
