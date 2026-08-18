/**
 * Single source of truth for the Settings page tab ids.
 *
 * Both the server page's deep-link allowlist (`page.tsx`) and the rendered
 * `TabsTrigger` values (`settings-page.tsx`) derive from these constants, so a
 * new tab can't be added to one place and forgotten in the other — which would
 * otherwise silently drop a deep-linked user on the default Profile tab.
 *
 * The values are the stable route/query wire ids (bookmarked as `?tab=<id>`
 * and used by OAuth callbacks); keep them stable even when a tab's visible
 * label changes.
 */
export const SettingsTab = {
  Profile: "profile",
  Organization: "organization",
  CustomFields: "custom-fields",
  Compliance: "compliance",
  Tags: "tags",
  Integrations: "integrations",
  ApiKeys: "api-keys",
} as const;

export type SettingsTab = (typeof SettingsTab)[keyof typeof SettingsTab];

/**
 * The query key that carries a tab id: `?tab=<SettingsTab>`.
 *
 * As much a stable wire value as the ids themselves — it is what gets
 * bookmarked and shared — so client code that reads or repairs it imports this
 * rather than respelling the literal.
 */
export const SETTINGS_TAB_PARAM = "tab";

export const DEFAULT_SETTINGS_TAB: SettingsTab = SettingsTab.Profile;

// Tabs every member can reach.
export const BASE_SETTINGS_TABS: readonly SettingsTab[] = [
  SettingsTab.Profile,
  SettingsTab.Organization,
  SettingsTab.Integrations,
  SettingsTab.ApiKeys,
  SettingsTab.Tags,
];

// Admin/owner-only tabs, appended to the allowlist for admins.
export const ADMIN_SETTINGS_TABS: readonly SettingsTab[] = [
  SettingsTab.CustomFields,
  SettingsTab.Compliance,
];

/**
 * DOM id of the `Anthropic API Key` card, and the URL fragment that scrolls to
 * it: `/<org>/settings?tab=integrations#anthropic-api-key`.
 *
 * The Integrations tab stacks Cloud compute mode, Local compute targets, this
 * card, GitHub, Google, and Linear, so a deep link that only selected the tab
 * left the arriving user to scan for the card it sent them for. Anything that
 * links a user to a specific Integrations card should target it by id like
 * this rather than trusting tab selection alone.
 *
 * Stable wire value for the same reason the tab ids are: it is bookmarkable.
 */
export const ANTHROPIC_API_KEY_CARD_ANCHOR = "anthropic-api-key";

/**
 * Query keys this page reads as an integration OAuth callback.
 *
 * These OUTRANK `?tab=`: any nonempty value on one of them forces the
 * Integrations tab (`resolveInitialTab` in `page.tsx`), because the returning
 * admin has to land on the card that renders the updated status, toast, or
 * different-account confirmation dialog.
 *
 * Exported so both sides of that precedence read one list. `page.tsx` detects a
 * callback from it, and `apps/app/lib/app-route-redirects.ts` clears the same
 * keys off any retired-route forward whose whole purpose is to select a
 * DIFFERENT tab — otherwise a bookmarked `/organization?github=bogus` arrives
 * on Integrations while its own URL says `tab=organization`.
 */
export const SettingsIntegrationCallbackParam = {
  GitHub: "github",
  Google: "google",
  Linear: "linear",
} as const;

export type SettingsIntegrationCallbackParam =
  (typeof SettingsIntegrationCallbackParam)[keyof typeof SettingsIntegrationCallbackParam];

export const SETTINGS_INTEGRATION_CALLBACK_PARAMS: readonly SettingsIntegrationCallbackParam[] =
  [
    SettingsIntegrationCallbackParam.GitHub,
    SettingsIntegrationCallbackParam.Google,
    SettingsIntegrationCallbackParam.Linear,
  ];
