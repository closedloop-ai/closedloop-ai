import { SettingsPanelIntent } from "@repo/api/src/types/settings-panel";

/**
 * @file members-embed-start-view.ts
 * @description Which view Clerk's `<OrganizationProfile>` embed opens on inside
 * the Settings v2 Members panel, and how the panel asks for it (ISS-8368 M1).
 *
 * ROUTING MODE AND INVITE INTENT ARE ONE DECISION, and both were settled
 * against the INSTALLED SDK rather than its documentation:
 *
 * - `routing="virtual"` is not available. `OrganizationProfileProps` extends
 *   `RoutingOptions`, which is a union of `{routing?: 'path'}` and
 *   `{routing?: 'hash'}` — `RoutingStrategy` names `virtual`, but the props
 *   type `Extract`s it away. `path` would write Clerk's inner route into the
 *   app URL, which the Settings v2 shell owns (`?panel=` / `intent=`), so the
 *   mode is `hash` — the same mode every other Clerk embed in this repo uses.
 * - `__experimental_startPath` looks like the mechanism and is not one here.
 *   Only Clerk's `VirtualRouter` (the MODAL path, `openOrganizationProfile`)
 *   reads it; `HashRouter` passes a hard-coded `startPath: ""`. On a mounted
 *   hash-routed embed the prop is inert.
 * - So the one mechanism a mounted embed honours is the URL FRAGMENT, which
 *   its `HashRouter` reads on every render. Seeding it is not optional
 *   polish: with an empty fragment the embed opens Clerk's index route, which
 *   is Organization General — a page the `organizationGeneral` panel already
 *   owns. A Members panel showing General would be the wrong panel.
 *
 * WHY `Invite` AND `View` RESOLVE TO THE SAME VIEW. Clerk 1.6.5 has no
 * invitations ROUTE: `OrganizationProfileRoutes` routes only
 * `organization-general`, `organization-members`, `organization-billing` and
 * `organization-api-keys`, and invitations is a `Tab` INSIDE the members page
 * whose `Tabs` is rendered with no `defaultIndex`. The invite composer behind
 * it is uncontrolled `Action` state, not URL-derived. No prop, path, or
 * fragment reaches either. `intent=invite` therefore lands on the members
 * page, which is where Clerk's own Invitations tab and Invite button live —
 * the fallback the panel contract already prescribes for an intent a panel
 * cannot honour, and never a blank frame or a different panel.
 */

/** Clerk's own path for the members page, relative to the embed's router. */
export const CLERK_ORGANIZATION_MEMBERS_PATH = "/organization-members";

/**
 * The view each deep-link intent opens the embed on. An exhaustive `Record`
 * rather than a `switch` or a lookup list so a new `SettingsPanelIntent` fails
 * `tsc` here instead of silently falling through to whatever this file's
 * default happened to be.
 */
export const MEMBERS_EMBED_START_PATH_BY_INTENT: Record<
  SettingsPanelIntent,
  string
> = {
  [SettingsPanelIntent.Invite]: CLERK_ORGANIZATION_MEMBERS_PATH,
  [SettingsPanelIntent.SyncPolicy]: CLERK_ORGANIZATION_MEMBERS_PATH,
  [SettingsPanelIntent.View]: CLERK_ORGANIZATION_MEMBERS_PATH,
};

/**
 * The fragment the panel should write to open the embed on {@link intent}'s
 * view, or `null` when it must write nothing.
 *
 * `null` is returned once the fragment is already inside Clerk's router space
 * (`#/…`, the shape `hasUrlInFragment` recognises), because by then the
 * fragment is the embed's own navigation state. Re-seeding it on a later
 * render would drag a user who has clicked through to Billing back to the
 * members page under them.
 *
 * Only the fragment is ever produced. The shell's `?panel=members&intent=…`
 * live in the query string, and a fragment write cannot disturb them — which
 * is what makes `hash` routing safe under a shell that owns the deep link.
 */
export function resolveMembersEmbedStartHash(
  currentHash: string,
  intent: SettingsPanelIntent
): string | null {
  if (isClerkEmbedRouterFragment(currentHash)) {
    return null;
  }
  return `#${MEMBERS_EMBED_START_PATH_BY_INTENT[intent]}`;
}

/**
 * Whether the fragment is inside Clerk's router space rather than the app's.
 *
 * One predicate for both halves of the fragment's life: the seed skips a
 * fragment that is already the embed's, and the panel clears one on the way out
 * only when it is the embed's to clear.
 */
export function isClerkEmbedRouterFragment(currentHash: string): boolean {
  return currentHash.startsWith("#/");
}
