import { WEB_CANONICAL_LANDING_HREF } from "@repo/app/shared/lib/primary-nav-destinations";
import { auth } from "@repo/auth/server";
import { redirect } from "next/navigation";

// ISS-10855 / PLN-2088 step 6 (operator ruling, 2026-09-22): `/` has no page
// of its own. Signed-out visits go to Clerk sign-up, the same FEA-632 redirect
// the (authenticated) layout applies to every other signed-out app URL;
// signed-in visits forward to the shell's landing route.
//
// The href is the shared constant, not a literal: this entry point used to
// hardcode `/my-tasks` and so ignored the canonical landing route entirely,
// which is why `/` still opened My Tasks for a workspace whose own root had
// already moved on. The org-slug prefix is added downstream by the proxy's
// bare-route rewrite.
export default async function RootPage() {
  const { redirectToSignUp, userId } = await auth();
  if (!userId) {
    // ISS-11429: the return URL is the canonical landing route, never `/`.
    // Clerk defaults `returnBackUrl` to the URL being served, so the bare call
    // this used to make produced `/sign-up?redirect_url=https://app…/` — the
    // sign-up page naming the page that sent the visitor to it, which is the
    // self-referring shape 16 of the measured looping views carried.
    //
    // This does NOT by itself add an exit: `/dashboard` is protected too, so a
    // browser the server keeps reading as signed out re-enters
    // `redirectToSignUp()` there just the same. What bounds that is the proxy's
    // `auth-bounce-guard`. What this fixes is `/` naming ITSELF as the way
    // onward, which made the app root a second entrance to the cycle for a
    // visitor who had asked for nothing protected at all.
    return redirectToSignUp({ returnBackUrl: WEB_CANONICAL_LANDING_HREF });
  }

  redirect(WEB_CANONICAL_LANDING_HREF);
}
