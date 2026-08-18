import { isPathSafeSlug } from "@repo/api/src/types/reserved-slugs";
import { notFound, redirect } from "next/navigation";

/**
 * FEA-3983/3970: Agent Monitoring is removed, but a deep link to one specific
 * session (the kind pasted into Slack / inbox items) must not 404. Keep the
 * per-session redirect pointing at the canonical org-scoped Sessions detail
 * route. Both `orgSlug` and the session `id` are checked for path safety before
 * interpolation so an encoded-slash segment cannot forge an off-site open
 * redirect. `isPathSafeSlug` is looser than `orgSlugSchema` on purpose so a
 * legacy Clerk-id-fallback org slug (`org_...`) still forwards instead of
 * 404ing.
 */
export default async function MonitoringSessionDetailRedirect({
  params,
}: {
  params: Promise<{ orgSlug: string; id: string }>;
}) {
  const { orgSlug, id } = await params;
  if (!(isPathSafeSlug(orgSlug) && isPathSafeSlug(id))) {
    notFound();
  }
  redirect(`/${orgSlug}/sessions/${id}`);
}
