/**
 * @file settings-deep-link-adapters.ts
 * @description ISS-8380 — the legacy-to-v2 Settings deep-link and OAuth-callback
 * precedence adapters, and the rollback adapter that runs the other way.
 *
 * Both directions have to work AT THE SAME TIME for the whole rollout window,
 * because the two trees are alive at once: a user moved onto v2 still holds
 * `?tab=` bookmarks, and a user moved back off it holds `?panel=` ones. Neither
 * adapter reads the program rollout flag — the root experience selector is the
 * only consumer allowed to choose a tree, and these are pure functions it (or a
 * shell it mounted) calls with the request it already has.
 *
 * Nothing here deletes, hides, or renames a legacy contract.
 *
 * WHICH OF THESE IS WIRED, stated plainly because the difference is invisible
 * from the test file. `resolveLegacyTabForV2Panel` — the rollback direction —
 * has a production caller today, the legacy Settings page, and is asserted
 * through it. Native v2 `?panel=` links also have a production caller now for
 * ISS-8353's onboarding sync-policy route. {@link resolveV2SettingsDeepLink}
 * gained a production caller with ISS-10195: `settings-route-state.ts` calls it
 * for every Settings visit now that retiring the `workspace-experience-v2` gate
 * mounted the v2 tree unconditionally, so the forward `?tab=` promise IS
 * honoured on the v2 tree and this adapter is what honours it.
 * {@link isRetainedLegacySettingsPath} still has no production caller. What
 * remains genuinely legacy-only is the GitHub OAuth-callback route —
 * `SettingsRouteRoot` still renders the legacy page for
 * `SettingsV2RouteKind.LegacyCallback` — plus the rows with no v2 owner that
 * ISS-10286 tracks (the security target). ISS-10316 gave `?tab=integrations`
 * and the Google callback an owner: the Plugins panel.
 */

import {
  DEFAULT_SETTINGS_PANEL_ID,
  DEFAULT_SETTINGS_PANEL_INTENT,
  isSettingsPanelId,
  resolveRetiredSettingsPanelId,
  SETTINGS_PANEL_PARAM,
  type SettingsPanelId,
  type SettingsPanelIntent,
} from "@repo/api/src/types/settings-panel";
import {
  SETTINGS_INTEGRATION_CALLBACK_PARAMS,
  SETTINGS_TAB_PARAM,
  type SettingsIntegrationCallbackParam,
  type SettingsTab,
} from "@/app/(authenticated)/[orgSlug]/settings/settings-tabs";
import {
  LEGACY_SETTINGS_TAB_FRAGMENT_SUCCESSOR,
  LEGACY_SETTINGS_TAB_SUCCESSOR,
  RETAINED_LEGACY_SETTINGS_PATHS,
  SETTINGS_CALLBACK_V2_PANEL,
  V2_SETTINGS_PANEL_LEGACY_ORIGIN,
} from "./settings-migration-matrix";

/** Where a path stops and its query or fragment begins. */
const QUERY_OR_FRAGMENT = /[?#]/;

/**
 * Why the resolved panel was chosen. Reported alongside the panel so a caller —
 * and a test — can tell "the link asked for this" from "the link asked for
 * nothing we have", which are the same OUTCOME and different facts.
 */
export const SettingsDeepLinkSource = {
  /** An integration OAuth callback param won, as it does on the legacy tree. */
  Callback: "callback",
  /**
   * An integration OAuth callback arrived for a provider NO v2 panel renders.
   *
   * Kept distinct from {@link Default} because it is a different fact with a
   * different remedy: the user came back holding a result, and the v2 tree has
   * nowhere to show it. A caller that collapses this into "the link named
   * nothing" silently drops an OAuth outcome. Until the provider has a v2
   * owner, such a request belongs on the legacy tree.
   */
  UnownedCallback: "unowned-callback",
  /** A legacy `?tab=` naming exactly one v2 successor. */
  LegacyTab: "legacy-tab",
  /**
   * Nothing resolvable: absent or unrecognized. Both land on the authorized
   * default rather than a guess or an error.
   */
  Default: "default",
} as const;

export type SettingsDeepLinkSource =
  (typeof SettingsDeepLinkSource)[keyof typeof SettingsDeepLinkSource];

export type LegacySettingsDeepLink = {
  /** The raw `?tab=` value, whatever a bookmark actually carried. */
  tab?: string | string[];
} & Partial<Record<SettingsIntegrationCallbackParam, string | string[]>>;

export type ResolvedV2SettingsDeepLink = {
  panel: SettingsPanelId;
  intent: SettingsPanelIntent;
  source: SettingsDeepLinkSource;
};

/**
 * Where a LEGACY Settings link should land on the v2 tree.
 *
 * Precedence mirrors the legacy page's own, which is the point: an integration
 * OAuth callback outranks `?tab=` there because the returning admin has to see
 * the card that renders the result, and moving that user to a different panel
 * in v2 would break the same promise. The Integrations tab those callbacks
 * targeted no longer exists, so a provider is resolved to the panel that
 * inherits it rather than to the tab — and where nothing inherits it yet, to
 * {@link SettingsDeepLinkSource.UnownedCallback} rather than to a panel that
 * cannot render the result. Which providers those are, and why, is
 * {@link SETTINGS_CALLBACK_V2_PANEL}.
 *
 * An unrecognized tab and an absent tab resolve to
 * {@link DEFAULT_SETTINGS_PANEL_ID}. That is the authorized default,
 * never an error and never an empty screen: a version-skewed link must degrade
 * to a usable Settings page.
 */
export function resolveV2SettingsDeepLink(
  link: LegacySettingsDeepLink
): ResolvedV2SettingsDeepLink {
  const callback = resolveCallbackDeepLink(link);
  if (callback) {
    return callback;
  }

  const tab = firstValue(link.tab);
  const successor = tab ? lookupTabSuccessor(tab) : undefined;
  if (successor) {
    return {
      panel: successor,
      intent: DEFAULT_SETTINGS_PANEL_INTENT,
      source: SettingsDeepLinkSource.LegacyTab,
    };
  }

  return {
    panel: DEFAULT_SETTINGS_PANEL_ID,
    intent: DEFAULT_SETTINGS_PANEL_INTENT,
    source: SettingsDeepLinkSource.Default,
  };
}

/**
 * The panel a legacy `?tab=` link's card fragment belongs on, when that card
 * left the panel the tab maps to — or `null` to keep the server's resolution.
 *
 * Takes the raw `location.search` and `location.hash`, because the fragment
 * never reaches the server that resolved the tab. Only a link that
 * {@link resolveV2SettingsDeepLink} resolved through its tab qualifies: an
 * explicit `?panel=` or an OAuth callback already chose the panel, and a
 * fragment must not override either.
 */
export function resolveLegacySettingsFragmentPanel(
  search: string,
  hash: string
): SettingsPanelId | null {
  const params = new URLSearchParams(search);
  if (firstValue(params.getAll(SETTINGS_PANEL_PARAM)) !== null) {
    return null;
  }
  const link: LegacySettingsDeepLink = {
    tab: params.getAll(SETTINGS_TAB_PARAM),
  };
  for (const key of SETTINGS_INTEGRATION_CALLBACK_PARAMS) {
    link[key] = params.getAll(key);
  }
  if (
    resolveV2SettingsDeepLink(link).source !== SettingsDeepLinkSource.LegacyTab
  ) {
    return null;
  }
  const tab = firstValue(link.tab);
  const fragment = readFragment(hash);
  if (tab === null || fragment === null) {
    return null;
  }
  const byFragment = Object.getOwnPropertyDescriptor(
    LEGACY_SETTINGS_TAB_FRAGMENT_SUCCESSOR,
    tab
  )?.value as Readonly<Record<string, SettingsPanelId>> | undefined;
  if (byFragment === undefined) {
    return null;
  }
  return (
    (Object.getOwnPropertyDescriptor(byFragment, fragment)?.value as
      | SettingsPanelId
      | undefined) ?? null
  );
}

/**
 * Which legacy tab a v2 `?panel=` link maps onto — the ROLLBACK direction.
 *
 * `null` means the link named nothing the legacy tree can honour, and is
 * deliberately not the legacy default tab: the caller already has its own
 * default and its own allowlist, and collapsing "named nothing" into "named
 * Profile" here would let this adapter override an explicit `?tab=`.
 */
export function resolveLegacyTabForV2Panel(
  panel: string | string[] | undefined
): SettingsTab | null {
  const value = firstValue(panel);
  if (!value) {
    return null;
  }
  const origin = lookupPanelOrigin(value);
  if (origin?.kind !== "tab") {
    return null;
  }
  return origin.tab;
}

/**
 * Whether this pathname is a legacy Settings path an already-installed Desktop
 * build hard-codes, and which therefore may not be forwarded, rewritten, or
 * retired by any v2 route consolidation.
 *
 * Prefix-matched, because the shipped links carry their own query. Both the org-prefixed
 * form the proxy produces and the bare form the Desktop app emits are accepted,
 * since the app has no org slug to include.
 *
 * The query and fragment are CUT before matching, and that is the whole point
 * rather than tidiness: the real pairing link the device-onboarding service
 * mints is `/settings/integrations/desktop/connect?code=…`
 * (`apps/api/app/desktop/device-onboarding/service.ts`). Matching the raw
 * remainder answered false for it — neither equal to the retained entry nor
 * followed by a `/` — so the one guard protecting the highest-risk rows in the
 * removal checklist failed on the exact URL it exists to protect.
 */
export function isRetainedLegacySettingsPath(pathname: string): boolean {
  const settingsIndex = pathname.indexOf("/settings/");
  if (settingsIndex < 0) {
    return false;
  }
  const suffix = pathname.slice(settingsIndex).split(QUERY_OR_FRAGMENT)[0];
  return RETAINED_LEGACY_SETTINGS_PATHS.some(
    (retained) => suffix === retained || suffix.startsWith(`${retained}/`)
  );
}

/**
 * The value of a search param at POSITION 0 — the same rule the other two
 * readers of these bags use, which is why it is position 0 and not "the first
 * nonempty entry". `parseSettingsRouteParams`
 * (`packages/api/src/types/settings-route.ts:32`) takes `[0]`, and the legacy
 * page's `getRequestedTab`
 * (`apps/app/app/(authenticated)/[orgSlug]/settings/page.tsx:53`) takes `[0]`.
 * Skipping a blank first entry here made `?panel=&panel=tags` open Tags on the
 * rollback path while both of the others answered the default: one bag, three
 * readers, two conventions.
 *
 * An empty string is still not a value, so a lone `?panel=` reads as absent.
 */
function firstValue(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === undefined || value.length === 0 ? null : value;
}

function readFragment(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw.length === 0) {
    return null;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * Whether a callback key carries a real value ANYWHERE in a repeated key.
 *
 * Deliberately NOT {@link firstValue}'s position-0 rule: the question a callback
 * key answers is "did an OAuth round trip happen", and the legacy page asks it
 * exactly this way (`hasSearchParamValue` in its `page.tsx`). A callback that
 * outranks `?tab=` there has to outrank it here, or the two trees disagree about
 * whether the returning admin has a result to be shown.
 */
function hasCallbackValue(raw: string | string[] | undefined): boolean {
  if (Array.isArray(raw)) {
    return raw.some((entry) => entry.length > 0);
  }
  return raw !== undefined && raw.length > 0;
}

/**
 * Own-property read: the incoming value is untrusted URL text, so a crafted
 * `__proto__` or `constructor` would otherwise resolve through the prototype
 * chain and hand back a truthy non-successor. The legacy tab vocabulary has no
 * exported type guard of its own, which is why this map is read this way and
 * the panel map below is not.
 */
function lookupTabSuccessor(tab: string) {
  return Object.getOwnPropertyDescriptor(LEGACY_SETTINGS_TAB_SUCCESSOR, tab)
    ?.value as (typeof LEGACY_SETTINGS_TAB_SUCCESSOR)[SettingsTab] | undefined;
}

/**
 * Narrowed by the panel vocabulary's own `isSettingsPanelId` rather than a
 * second hand-rolled guard, so a prototype key is rejected by the same
 * predicate every other v2 consumer uses instead of by a local copy of the rule.
 */
function lookupPanelOrigin(panel: string) {
  const resolved = resolveRetiredSettingsPanelId(panel);
  return isSettingsPanelId(resolved)
    ? V2_SETTINGS_PANEL_LEGACY_ORIGIN[resolved]
    : undefined;
}

/**
 * The callback leg of {@link resolveV2SettingsDeepLink}, or `null` when no
 * OAuth round trip is present at all.
 *
 * A callback whose provider has no v2 owner still lands on the authorized
 * default panel — a version-skewed link must never produce an error or an empty
 * screen — but it reports {@link SettingsDeepLinkSource.UnownedCallback} so the
 * caller can see that a result was carried and not shown, rather than reading
 * the same panel as an ordinary visit.
 */
function resolveCallbackDeepLink(
  link: LegacySettingsDeepLink
): ResolvedV2SettingsDeepLink | null {
  const key = SETTINGS_INTEGRATION_CALLBACK_PARAMS.find((candidate) =>
    hasCallbackValue(link[candidate])
  );
  if (!key) {
    return null;
  }
  const panel = SETTINGS_CALLBACK_V2_PANEL[key];
  if (panel === null) {
    return {
      panel: DEFAULT_SETTINGS_PANEL_ID,
      intent: DEFAULT_SETTINGS_PANEL_INTENT,
      source: SettingsDeepLinkSource.UnownedCallback,
    };
  }
  return {
    panel,
    intent: DEFAULT_SETTINGS_PANEL_INTENT,
    source: SettingsDeepLinkSource.Callback,
  };
}
