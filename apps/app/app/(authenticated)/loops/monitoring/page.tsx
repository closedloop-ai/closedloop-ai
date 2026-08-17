import { orgSlugSchema } from "@repo/api/src/types/reserved-slugs";
import { auth } from "@repo/auth/server";
import { redirect } from "next/navigation";

/**
 * FEA-3983/3970: legacy (non-org-slug) Agent Monitoring route. Agent Monitoring
 * is removed (superseded by Sessions). Kept only as a temporary redirect so old
 * bookmarks land on Sessions instead of 404ing. The org slug comes from the
 * Clerk session because this legacy path carries no slug segment; if it is
 * unavailable (or malformed) we fall back to the app root, which resolves the
 * active org and routes onward.
 *
 * Temporary (307), not permanent (308): the session-derived destination changes
 * per user, so it must never be cached as a permanent redirect (a 308 to one
 * org's Sessions would stick for the next user behind a shared cache).
 */
export default async function LegacyMonitoringRedirect() {
  const { orgSlug } = await auth();
  if (orgSlug && orgSlugSchema.safeParse(orgSlug).success) {
    redirect(`/${orgSlug}/sessions`);
  }
  redirect("/");
}
