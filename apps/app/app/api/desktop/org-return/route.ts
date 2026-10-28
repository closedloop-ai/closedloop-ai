import { withOrgSlug } from "@repo/app/documents/lib/document-navigation";
import { WEB_CANONICAL_LANDING_HREF } from "@repo/app/shared/lib/primary-nav-destinations";
import { auth } from "@repo/auth/server";
import { type NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import {
  DESKTOP_ORG_RETURN_PARAM,
  resolveDesktopAuthorizeReturnTarget,
} from "@/lib/desktop-org-return";

/**
 * GET /api/desktop/org-return
 *
 * Where Clerk lands a person who just created an organization DURING a
 * desktop-originated authorize run (ISS-11272). It exists so that decision is
 * made on the server: the target arrives on a query string the client composed,
 * and a post-creation navigation target is exactly the kind of value that must
 * not be trusted from there. `/connect/github/link` validates its `returnTo`
 * server-side for the same reason.
 *
 * A target that does not resolve to this origin's desktop authorize page — a
 * missing one, an off-origin one, a same-origin page this flow has no business
 * resuming on — falls back to the web canonical landing, which is where org
 * creation went before this route existed. So a rejected value degrades to the
 * old behavior rather than to an error page.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const target = resolveDesktopAuthorizeReturnTarget(
    request.nextUrl.searchParams.get(DESKTOP_ORG_RETURN_PARAM),
    env.NEXT_PUBLIC_APP_URL
  );

  // A RELATIVE `Location`, and no origin is derived at all.
  //
  // This used to build an absolute URL on `request.nextUrl.origin`, justified in
  // a comment as what `buildGitHubConnectRedirectUrl` does. It is not: that
  // function's production caller is `apps/app/proxy.ts`, i.e. MIDDLEWARE, where
  // `nextUrl` reflects the URL the browser asked for. A route handler's does
  // not — it carries the server's bind address. Containerized, that is
  // `http://0.0.0.0:3000` while the browser is on `http://localhost:3000`, so
  // the redirect left the origin, the Clerk session cookie was not sent with it,
  // and Clerk's handshake bounced the browser between the two forever
  // (ERR_TOO_MANY_REDIRECTS — ISS-11272 e2e, and the reason `nextUrl.origin`
  // appears nowhere else in `apps/app`).
  //
  // Relative is legal (RFC 7231 section 7.1.2) and the browser resolves it
  // against the host it actually used, which is the only host that has the
  // cookie. Deriving one from `x-forwarded-host` instead would put
  // client-supplied input into a redirect on the one route whose entire purpose
  // is refusing client-supplied redirect targets; `target` is already validated
  // to a same-origin path, so relative adds no surface.
  return new NextResponse(null, {
    status: TEMPORARY_REDIRECT_STATUS,
    headers: { location: target ?? (await webLandingFallback()) },
  });
}

/**
 * 307, which is exactly what `NextResponse.redirect()` emitted here before this
 * route stopped building an absolute URL — preserved rather than folded into the
 * proxy's `RedirectStatus`, whose `Temporary` is 302. Switching to 302 would let
 * a client rewrite the method, and changing the status is not what this fix is
 * for.
 */
const TEMPORARY_REDIRECT_STATUS = 307;

/**
 * The pre-ISS-11272 destination, org-scoped from the session.
 *
 * Read AFTER the creation, so the slug is the NEW organization's — Clerk has
 * already made it active by the time it sends the browser here. With no slug to
 * resolve, the app root is the honest answer: `OrgIdentityProvider` reconciles
 * the URL from there, whereas a guessed prefix resolves to nothing.
 */
async function webLandingFallback(): Promise<string> {
  const { orgSlug } = await auth();
  if (!orgSlug) {
    return "/";
  }
  return withOrgSlug(orgSlug, WEB_CANONICAL_LANDING_HREF) ?? "/";
}
