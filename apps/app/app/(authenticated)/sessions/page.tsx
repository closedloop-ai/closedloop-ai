import { orgSlugSchema } from "@repo/api/src/types/reserved-slugs";
import { auth } from "@repo/auth/server";
import { redirect } from "next/navigation";

/**
 * FEA-4155: legacy (non-org-slug) Sessions list. This older layout (h1 +
 * description + info cards, no toolbar/KPI strip) was a second, differently-
 * designed page for the same job as the canonical `/{orgSlug}/sessions` route,
 * and it was still behind the winding-down `DESKTOP_AGENT_SESSION_SYNC` flag —
 * so as the flag winds down it renders nothing. Nothing links to it except its
 * own `/sessions/[id]` detail route. Collapse the duplicate surface by
 * redirecting to the canonical org Sessions list (bot review #3789), matching
 * the existing legacy-monitoring redirect pattern
 * (`loops/monitoring/page.tsx`). The `[id]` detail route stays — its
 * "Back to sessions" now lands here and forwards on.
 *
 * The org slug comes from the Clerk session because this legacy path carries no
 * slug segment; if it is unavailable (or malformed) we fall back to the app
 * root, which resolves the active org and routes onward.
 *
 * Temporary (307), not permanent (308): the session-derived destination changes
 * per user, so it must never be cached as a permanent redirect (a 308 to one
 * org's Sessions would stick for the next user behind a shared cache).
 */
export default async function LegacySessionsRedirect() {
  const { orgSlug } = await auth();
  if (orgSlug && orgSlugSchema.safeParse(orgSlug).success) {
    redirect(`/${orgSlug}/sessions`);
  }
  redirect("/");
}
