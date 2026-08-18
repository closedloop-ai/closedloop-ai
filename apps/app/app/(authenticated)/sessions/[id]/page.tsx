import { orgSlugSchema } from "@repo/api/src/types/reserved-slugs";
import { auth } from "@repo/auth/server";
import { redirect } from "next/navigation";

/**
 * FEA-4155: legacy (non-org-slug) Sessions detail. Its sibling list page now
 * redirects to the canonical `/{orgSlug}/sessions` route (bot review #3789), and
 * this detail was still wrapped in `<FeatureFlagged>` on the winding-down
 * `DESKTOP_AGENT_SESSION_SYNC` flag — the exact blank-render class FEA-4155
 * fixes on the org surface. Collapse it into a server redirect to the canonical
 * org detail `/{orgSlug}/sessions/{id}`, preserving the query string so
 * transcript-file / invocation-anchor deep links survive. Matches the legacy
 * monitoring session-detail redirect (`loops/monitoring/sessions/[id]`).
 *
 * The org slug comes from the Clerk session (this legacy path carries no slug
 * segment); if it is unavailable/malformed, fall back to the non-org detail
 * path so the proxy's org-slug redirect can add the active org's segment.
 */
export default async function LegacySessionDetailRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, resolvedSearchParams, { orgSlug }] = await Promise.all([
    params,
    searchParams,
    auth(),
  ]);
  const query = buildQueryString(resolvedSearchParams);
  if (orgSlug && orgSlugSchema.safeParse(orgSlug).success) {
    redirect(`/${orgSlug}/sessions/${id}${query}`);
  }
  redirect(`/sessions/${id}${query}`);
}

function buildQueryString(
  searchParams: Record<string, string | string[] | undefined>
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        params.append(key, entry);
      }
    } else if (value !== undefined) {
      params.append(key, value);
    }
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}
