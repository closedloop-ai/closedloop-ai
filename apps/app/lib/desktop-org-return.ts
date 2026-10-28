import { DESKTOP_AUTHORIZE_PATHNAME } from "@repo/api/src/types/desktop-authorize-url";
import {
  GITHUB_CONNECT_REDIRECT_PARAM,
  resolveGitHubConnectRedirectTarget,
} from "./github-connect-redirect";

/**
 * Where a DESKTOP-ORIGINATED organization creation hands the user back
 * (ISS-11272).
 *
 * The desktop opens the loopback authorize URL in the system browser and then
 * waits on its loopback listener. Every web hop in that run therefore owes the
 * run a way back: `/connect/github` carries the authorize target through
 * sign-in for exactly this reason. Organization creation had no equivalent — it
 * always landed on the web canonical destination — so a person who created a
 * workspace mid-run never returned, and the desktop sat on a listener that
 * never fired.
 *
 * Two pieces, deliberately split the way the sibling flow splits them: the
 * client may only ever say "this run came from the desktop" by pointing at
 * {@link DESKTOP_ORG_RETURN_PATHNAME}, and the SERVER route behind that path is
 * what decides whether the target it named is trustworthy. Nothing the client
 * composes becomes a navigation target without passing
 * {@link resolveDesktopAuthorizeReturnTarget} first.
 */

/**
 * The server hop that validates a desktop-originated return target and
 * redirects to it.
 *
 * A route handler rather than a page: it renders nothing, and the only thing it
 * decides is a destination. `/api/integrations/github` validates its own
 * `returnTo` the same way and for the same reason.
 */
export const DESKTOP_ORG_RETURN_PATHNAME = "/api/desktop/org-return";

/**
 * Key the return target rides on.
 *
 * The SAME key `/connect/github` uses, imported rather than respelled: both
 * hops carry "where this run goes next" through the same open-redirect
 * boundary, and two spellings of one concept is how a future fix lands on only
 * one of them.
 */
export const DESKTOP_ORG_RETURN_PARAM = GITHUB_CONNECT_REDIRECT_PARAM;

/**
 * The org-scoped spelling of the authorize path: exactly one leading segment
 * (the org slug) ahead of the bare path, and nothing else. Anchored at both
 * ends so a deeper path that merely ENDS in the authorize path cannot pass.
 */
const ORG_SCOPED_DESKTOP_AUTHORIZE_PATTERN = new RegExp(
  `^/[^/]+${DESKTOP_AUTHORIZE_PATHNAME}$`,
  "u"
);

/**
 * Whether `pathname` is the desktop authorize consent route — the one page a
 * desktop-originated run is parked on while the person is in the browser.
 *
 * Reachable in both spellings: the bare path, and the org-scoped rewrite the
 * proxy produces once the session has an active org.
 */
export function isDesktopAuthorizeRunPathname(pathname: string): boolean {
  return (
    pathname === DESKTOP_AUTHORIZE_PATHNAME ||
    ORG_SCOPED_DESKTOP_AUTHORIZE_PATTERN.test(pathname)
  );
}

/**
 * Validate an untrusted return target down to "the desktop authorize page on
 * this origin", or `null`.
 *
 * TWO gates, because same-origin alone is not enough here. The first is the
 * shared open-redirect boundary (`//host`, `/\host`, an absolute off-origin
 * URL, `javascript:` — all rejected there, including the percent-encoded
 * backslash shapes that survive Next's decoding). The second narrows what is
 * left to the ONE destination a desktop-originated run can legitimately resume
 * on. That second gate is what makes this safe to hand a freshly-created
 * organization's first navigation: a same-origin path is not automatically a
 * place this flow should land, and an attacker who can compose the query
 * cannot pick one.
 *
 * Returns the same-origin `pathname + search` — the authorize params (PKCE
 * challenge, `state`, the loopback `redirect_uri`, the gateway key) ride
 * through untouched, because dropping any of them strands the desktop just as
 * surely as landing on the wrong page does. Those params are the authorize
 * page's own untrusted input and it validates them itself; this function
 * decides the PAGE, never the consent.
 */
export function resolveDesktopAuthorizeReturnTarget(
  rawTarget: string | null | undefined,
  appOrigin: string
): string | null {
  const sameOriginTarget = resolveGitHubConnectRedirectTarget(
    rawTarget,
    appOrigin
  );
  if (sameOriginTarget === null) {
    return null;
  }

  // Already known same-origin, so this re-parse only splits path from query.
  const parsed = safeParsePathname(sameOriginTarget, appOrigin);
  if (parsed === null || !isDesktopAuthorizeRunPathname(parsed)) {
    return null;
  }

  return sameOriginTarget;
}

/**
 * The href a client hands Clerk as `afterCreateOrganizationUrl` for a
 * desktop-originated run.
 *
 * `target` is UNVALIDATED here on purpose: this only composes the URL of the
 * server hop, and that hop is where the value is judged. A client that
 * composes a hostile target gets a redirect to the web landing page.
 */
export function buildDesktopOrgReturnHref(target: string): string {
  return `${DESKTOP_ORG_RETURN_PATHNAME}?${DESKTOP_ORG_RETURN_PARAM}=${encodeURIComponent(target)}`;
}

function safeParsePathname(target: string, appOrigin: string): string | null {
  try {
    return new URL(target, appOrigin).pathname;
  } catch {
    return null;
  }
}
