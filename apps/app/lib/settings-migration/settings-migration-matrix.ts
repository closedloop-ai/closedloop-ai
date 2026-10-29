/**
 * @file settings-migration-matrix.ts
 * @description ISS-8380 — the CLOSED half of the Settings legacy-to-v2 migration
 * matrix: the two exhaustive ownership maps between the legacy tab vocabulary
 * and the v2 panel vocabulary, plus the legacy paths a shipped Desktop build
 * hard-codes. The open inventory of routes, endpoints, commands, role checks,
 * and data fields is the sibling `./settings-migration-inventory.ts`.
 *
 * It records ownership and removes nothing; the removal gate is
 * `docs/runbooks/settings-v2-legacy-removal-checklist.md`.
 *
 * It lives in `apps/app` because it has to name both vocabularies at once and
 * `packages/api` cannot import from an app — the same reason
 * `app-route-redirects.ts` sits here. Neither id set is restated, so a rename in
 * either SSOT fails `tsc` here rather than drifting.
 *
 * The two maps below are exhaustive `Record`s, so adding a legacy tab or a v2
 * panel fails typecheck until it has an owner.
 */

import { SettingsPanelId } from "@repo/api/src/types/settings-panel";
import { ANTHROPIC_API_KEY_CARD_ANCHOR } from "@repo/api/src/types/settings-route-links";
import {
  SettingsIntegrationCallbackParam,
  SettingsTab,
} from "@/app/(authenticated)/[orgSlug]/settings/settings-tabs";

/**
 * Old owner → new owner for every legacy Settings tab.
 *
 * Six of the seven legacy tab ids are the SAME STRING as their v2 panel id
 * (`profile`, `organization`, `custom-fields`, `compliance`, `tags`,
 * `api-keys`), which is what makes those rows a reading of the two contracts
 * rather than a judgement call. `integrations` is the one that has no v2
 * counterpart, because v2 dissolved the tab; its row is an operator ruling.
 */
export const LEGACY_SETTINGS_TAB_SUCCESSOR: Record<
  SettingsTab,
  SettingsPanelId
> = {
  [SettingsTab.Profile]: SettingsPanelId.Profile,
  [SettingsTab.Organization]: SettingsPanelId.OrganizationGeneral,
  [SettingsTab.CustomFields]: SettingsPanelId.CustomFields,
  [SettingsTab.Compliance]: SettingsPanelId.Compliance,
  [SettingsTab.Tags]: SettingsPanelId.Tags,
  [SettingsTab.ApiKeys]: SettingsPanelId.ApiKeys,
  // The tab's cards went to several panels: Google Drive to Plugins (the
  // Linear card was removed in ISS-12856), the Anthropic and Pensero
  // credentials to API Keys, GitHub to Profile, and the device cards to
  // Connected Devices. Which ONE a bookmarked `?tab=integrations` opens was an
  // operator ruling on ISS-10316: Plugins, the panel whose subject is
  // connected tools and which the OAuth callbacks already open. Links whose
  // subject is one specific card are produced against that card's own panel.
  [SettingsTab.Integrations]: SettingsPanelId.Plugins,
};

/**
 * A legacy card anchor whose card left the panel its tab maps to. The fragment
 * names one card, so it outranks the tab-level successor above: a bookmarked
 * `?tab=integrations#anthropic-api-key` opens API Keys, where that card lived
 * until Loops were removed (PRD-795), while a bare `?tab=integrations` still
 * opens Plugins (ISS-10316). Kept so old bookmarks keep landing there.
 *
 * The URL fragment never reaches the server, so this is read on the client,
 * by `resolveLegacySettingsFragmentPanel`.
 */
export const LEGACY_SETTINGS_TAB_FRAGMENT_SUCCESSOR: Partial<
  Record<SettingsTab, Readonly<Record<string, SettingsPanelId>>>
> = {
  [SettingsTab.Integrations]: {
    [ANTHROPIC_API_KEY_CARD_ANCHOR]: SettingsPanelId.ApiKeys,
  },
};

/**
 * Where a v2 panel's subject matter lives in the legacy tree, for the rollback
 * direction: a v2 link that arrives after the program is rolled back.
 *
 * `none` means the panel has no legacy home at all, so a link naming it can only
 * degrade to the legacy default — a real outcome, kept distinct from a mapping
 * nobody filled in.
 */
export type V2PanelLegacyOrigin =
  | { kind: "tab"; tab: SettingsTab }
  | { kind: "none" };

/**
 * New owner → old owner for every v2 Settings panel.
 *
 * Each non-`none` row names the legacy tab that RENDERS that subject matter
 * today, cited in the sibling inventory: Members is Clerk's
 * `OrganizationProfile` inside the Organization tab, the Labs-group policy
 * toggles are the Organization tab's own cards, and the device and plugin
 * cards are stacked in the Integrations tab.
 */
export const V2_SETTINGS_PANEL_LEGACY_ORIGIN: Record<
  SettingsPanelId,
  V2PanelLegacyOrigin
> = {
  [SettingsPanelId.Profile]: { kind: "tab", tab: SettingsTab.Profile },
  [SettingsPanelId.ConnectedDevices]: {
    kind: "tab",
    tab: SettingsTab.Integrations,
  },
  [SettingsPanelId.Plugins]: { kind: "tab", tab: SettingsTab.Integrations },
  [SettingsPanelId.OrganizationGeneral]: {
    kind: "tab",
    tab: SettingsTab.Organization,
  },
  [SettingsPanelId.Members]: { kind: "tab", tab: SettingsTab.Organization },
  [SettingsPanelId.CustomFields]: {
    kind: "tab",
    tab: SettingsTab.CustomFields,
  },
  [SettingsPanelId.Tags]: { kind: "tab", tab: SettingsTab.Tags },
  [SettingsPanelId.Compliance]: { kind: "tab", tab: SettingsTab.Compliance },
  [SettingsPanelId.ApiKeys]: { kind: "tab", tab: SettingsTab.ApiKeys },
  [SettingsPanelId.OtherLabs]: {
    kind: "tab",
    tab: SettingsTab.Organization,
  },
  // ISS-10286. `none` is the accurate answer and not an unfilled cell: this map
  // is about the WEB legacy tree, and no web Settings tab has ever rendered the
  // desktop app's machine-local controls. Their legacy home is the desktop
  // renderer's own tab set (`apps/desktop/src/renderer/components/settings/`),
  // a third vocabulary `SettingsTab` does not speak.
  [SettingsPanelId.DesktopApp]: { kind: "none" },
};

/**
 * Which v2 panel renders the result of each legacy integration OAuth callback,
 * or `null` where NO v2 panel can render it yet.
 *
 * The legacy page gives these keys precedence over `?tab=` so the returning
 * admin lands on the card that shows the updated status; v2 has to keep that
 * promise, and the Integrations tab those callbacks targeted no longer exists.
 *
 * Google resolves to Plugins, which mounts its card and reports the `?google=`
 * outcome itself (ISS-10316). Linear also resolves to Plugins: its OAuth
 * callback route still returns with `?linear=`, although no Settings card has
 * read that param since ISS-12856 removed the Linear card. GitHub stays `null`: the v2 Profile
 * panel (`.../settings/components/v2/profile/profile-settings-panel-body.tsx`)
 * reads Clerk account data only and has no `?github=` read, so it cannot show
 * `github=requires_confirmation`, whose reset-confirmation dialog is
 * `readRequiresConfirmationParams` in
 * `.../settings/components/github-integration-card.tsx`. Naming Profile there
 * would send an OAuth result to a panel that cannot complete the flow, which is
 * a silent drop, not a fallback. Until that dialog has a v2 owner, the GitHub
 * callback is a reason the legacy page may not be removed (ISS-10246).
 */
export const SETTINGS_CALLBACK_V2_PANEL: Record<
  SettingsIntegrationCallbackParam,
  SettingsPanelId | null
> = {
  [SettingsIntegrationCallbackParam.GitHub]: null,
  [SettingsIntegrationCallbackParam.Google]: SettingsPanelId.Plugins,
  [SettingsIntegrationCallbackParam.Linear]: SettingsPanelId.Plugins,
};

/**
 * Paths an INSTALLED Desktop build hard-codes and opens in the system browser,
 * and which therefore cannot be moved by any v2 route consolidation: the binary
 * on a user's machine is not upgraded with the web app, so a rewrite here
 * breaks device authorization for every build already shipped.
 *
 * Org-prefix-less because that is the form the Desktop app produces; the proxy
 * adds the caller's org slug. Consulted by
 * `isRetainedLegacySettingsPath` in `./settings-deep-link-adapters.ts`.
 */
export const RETAINED_LEGACY_SETTINGS_PATHS: readonly string[] = [
  "/settings/integrations/desktop/authorize",
  "/settings/integrations/desktop/connect",
];
