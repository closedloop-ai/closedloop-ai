/**
 * @file settings-route-links.ts
 * @description The zod-free half of the Settings v2 deep-link contract: the
 * parsed-params shape, the in-app path guard, and the href builders. Split from
 * the parser (`./settings-route.ts`) on the same contract as
 * `agent-session-cloud-sync-state-constants.ts` — the Settings shell builds
 * links on every render but parses only at the route boundary, so a
 * bundle-sensitive `"use client"` surface must be able to import the builders
 * without dragging zod in.
 */
import {
  DEFAULT_SETTINGS_PANEL_INTENT,
  SETTINGS_CLOSE_ROUTE,
  SETTINGS_INTENT_PARAM,
  SETTINGS_PANEL_PARAM,
  SETTINGS_RETURN_TO_PARAM,
  SETTINGS_ROUTE,
  SettingsPanelId,
  type SettingsPanelIntent,
} from "./settings-panel.ts";

export type SettingsRouteParams = {
  /** The recognized panel, or null when absent OR unrecognized. */
  panel: SettingsPanelId | null;
  /**
   * The raw value the link asked for, trimmed, or null when the link named no
   * panel at all. A retired id arrives here as its successor.
   * `panel === null && requestedPanel !== null` is the unknown-panel case and
   * must not be rendered as a plain default visit.
   */
  requestedPanel: string | null;
  intent: SettingsPanelIntent;
  /**
   * A validated in-app path to close back to, or null for the default.
   *
   * HOST-ABSOLUTE, not org-relative: it is whatever the producing surface's own
   * router calls a path, so web supplies the slug-carrying `/acme/branches` it
   * reads from `usePathname()` and desktop supplies its slug-free `/branches`.
   * Making this the one org-relative value in the contract is what produced
   * `/acme/acme/branches` on web and an unroutable path on desktop: every other
   * route here is joined with the org slug at the surface seam, and a producer
   * holding a real path has no way to un-join it.
   */
  returnTo: string | null;
};

/**
 * Rejects anything that could leave the app: protocol-relative `//host`,
 * absolute URLs, and backslash forms browsers normalize to a slash. Only a
 * single-slash-rooted path survives, so a crafted `?returnTo=` cannot turn the
 * Settings close button into an open redirect.
 */
export function isInternalReturnTo(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//")) {
    return false;
  }
  return !(
    value.includes("\\") ||
    [...value].some((character) => character < " " || character === "\u007f")
  );
}

export type SettingsPanelRouteInput = {
  panel?: SettingsPanelId;
  intent?: SettingsPanelIntent;
  /** Host-absolute — see {@link SettingsRouteParams.returnTo}. */
  returnTo?: string | null;
};

/**
 * Org-relative href for a Settings deep link. The org slug is joined by the
 * caller's surface seam (`useOrgPath()` / `withOrgSlug`) so this stays usable
 * from desktop, which has no slug in its URLs.
 *
 * A default `intent` is omitted rather than serialized, so a version-skewed
 * build that has never heard of intents still lands on the right panel.
 */
export function buildSettingsPanelRoute(
  input: SettingsPanelRouteInput = {}
): string {
  const params = new URLSearchParams();
  if (input.panel !== undefined) {
    params.set(SETTINGS_PANEL_PARAM, input.panel);
  }
  if (
    input.intent !== undefined &&
    input.intent !== DEFAULT_SETTINGS_PANEL_INTENT
  ) {
    params.set(SETTINGS_INTENT_PARAM, input.intent);
  }
  if (
    input.returnTo !== undefined &&
    input.returnTo !== null &&
    isInternalReturnTo(input.returnTo)
  ) {
    params.set(SETTINGS_RETURN_TO_PARAM, input.returnTo);
  }
  const query = params.toString();
  return query.length === 0 ? SETTINGS_ROUTE : `${SETTINGS_ROUTE}?${query}`;
}

/**
 * The Members deep link, typed (ISS-8362 AC3). Delegates to
 * {@link buildSettingsPanelRoute} so the panel id, param keys, and intent
 * encoding have exactly one implementation; this exists so the workspace menu
 * and the invite flows (ISS-8363, ISS-8368) name the target by contract rather
 * than by hand-spelling `?panel=members`.
 */
export function buildMembersSettingsRoute(
  input: Omit<SettingsPanelRouteInput, "panel"> = {}
): string {
  return buildSettingsPanelRoute({
    ...input,
    panel: SettingsPanelId.Members,
  });
}

/**
 * Where the Settings close control navigates, as a path the CALLING SURFACE can
 * route to directly.
 *
 * `returnTo` is host-absolute and is returned verbatim; only the
 * {@link SETTINGS_CLOSE_ROUTE} default is org-relative and therefore joined
 * through `buildOrgPath`. Running a caller-supplied `returnTo` through the same
 * builder is what doubled the slug on web (`/acme/acme/branches`) while leaving
 * desktop with a path it could not match.
 */
export function resolveSettingsCloseRoute(
  params: Pick<SettingsRouteParams, "returnTo">,
  buildOrgPath: (orgRelativePath: string) => string
): string {
  return params.returnTo ?? buildOrgPath(SETTINGS_CLOSE_ROUTE);
}

/**
 * URL fragment of the retired BYO Anthropic credential card, kept so the
 * settings migration matrix can still redirect it. Stable wire value: it is
 * bookmarkable, and an older link (`?tab=integrations#anthropic-api-key`)
 * carries the same fragment.
 */
export const ANTHROPIC_API_KEY_CARD_ANCHOR = "anthropic-api-key";
