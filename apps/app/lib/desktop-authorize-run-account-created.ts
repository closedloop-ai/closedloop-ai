import { DESKTOP_AUTHORIZE_RUN_COOKIE } from "@repo/api/src/types/desktop-authorize-url";
import { parseDesktopAuthorizeParams } from "@repo/app/onboarding/lib/desktop-authorize-params";
import { auth, currentUser } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { cookies } from "next/headers";
import { parseDesktopAuthorizeRunCookie } from "./desktop-authorize-run";
import {
  desktopRunCreatedAccount,
  scheduleDesktopSignInAnalyticsReport,
} from "./desktop-sign-in-analytics";

/**
 * Whether the pending run behind this authorize page CREATED the account
 * (ISS-11395), derived on the server instead of read off the URL.
 *
 * True only when a valid run cookie exists, its `state` is the one this page's
 * URL carries, the run is not bound to a different user, and the signed-in
 * user was created at or after the run was issued. The run cookie is written
 * before Clerk decides between sign-in and sign-up, so creation time is the
 * only thing that tells the two apart — and nothing a link can carry affects
 * it, which is what lets the sign-IN arm never inherit a creation (ISS-10913).
 * `false` keeps its existing meaning of "no creation observed".
 *
 * Its own module rather than beside the codec because the proxy imports the
 * codec, and this reads request-scoped server APIs (`cookies()`, Clerk's
 * `currentUser`) and the logger, none of which belong in the middleware graph.
 */
export async function resolveDesktopRunAccountCreated({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}): Promise<boolean> {
  const cookieStore = await cookies();
  const run = parseDesktopAuthorizeRunCookie(
    cookieStore.get(DESKTOP_AUTHORIZE_RUN_COOKIE)?.value,
    Date.now()
  );
  if (run === null) {
    return false;
  }
  const parsed = parseDesktopAuthorizeParams(searchParams);
  if (!parsed.ok || parsed.params.state !== run.state) {
    return false;
  }

  try {
    const user = await currentUser();
    const created = desktopRunCreatedAccount(run, user);
    if (created) {
      scheduleDesktopSignInAnalyticsReport(run, auth);
    }
    return created;
  } catch (error) {
    log.warn("[desktop-authorize-run] Could not load the signed-in user", {
      status: "warn",
      error,
    });
    return false;
  }
}
