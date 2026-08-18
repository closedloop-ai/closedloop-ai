import { isPathSafeSlug } from "@repo/api/src/types/reserved-slugs";
import { notFound, redirect } from "next/navigation";

/**
 * ISS-4477: The "Loops" concept is retired from nav & UI. The primary-nav
 * destination (sidebar Labs entry + command-palette command) and the Loops
 * landing list are removed. This route is kept only as a temporary redirect so
 * bookmarks and old breadcrumb/inbox links to the Loops list keep working.
 *
 * Destination is Sessions, the actual successor: someone who bookmarked the
 * Loops list wanted a list of runs across the org, which is exactly what
 * Sessions now is. (My Tasks is a personal queue and would read as a bug.) This
 * matches the sibling Monitoring redirect, which also forwards to Sessions.
 *
 * The underlying loops service / data plumbing is intentionally untouched — this
 * is a nav+UI removal only. Per-execution detail (`loops/[id]`) still exists and
 * is reached functionally from plans and document-run flows.
 *
 * Temporary (307), not permanent (308): a 308 is aggressively cached by browsers
 * and would be near-impossible to repoint later. `orgSlug` is checked for path
 * safety before it is interpolated so an attacker-controlled encoded slug (e.g.
 * `%2Fevil.example`) cannot forge an open redirect to an off-site host. The
 * looser `isPathSafeSlug` check (vs `orgSlugSchema`) is deliberate: legacy orgs
 * whose stored slug is the raw Clerk-id fallback (`org_...`, underscores + mixed
 * case) would fail the kebab-only schema and 404 an otherwise-valid bookmark.
 */
export default async function LoopsListRedirect({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  if (!isPathSafeSlug(orgSlug)) {
    notFound();
  }
  redirect(`/${orgSlug}/sessions`);
}
