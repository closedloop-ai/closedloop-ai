import { getRoutePrefixForType } from "@repo/api/src/types/document";
import { auth } from "@repo/auth/server";
import { notFound, redirect } from "next/navigation";
import { resolveApiOrigin } from "@/lib/api-origin";

/**
 * Catch-all artifact redirect route.
 * Resolves an artifact slug to the correct type-specific route.
 *
 * This route exists as a fallback for Liveblocks inbox notification URLs
 * when room metadata is missing (fire-and-forget room creation).
 * The resolver tries to build type-specific URLs, but falls back to
 * /documents/:slug which lands here and redirects appropriately.
 */

type DocumentPageProps = {
  params: Promise<{ orgSlug: string; slug: string }>;
};

export default async function ArtifactRedirectPage({
  params,
}: DocumentPageProps) {
  const { orgSlug, slug } = await params;

  // Try to find the artifact by slug via the API. Resolve the destination
  // inside the try, but call redirect() *outside* of it: redirect() works by
  // throwing a NEXT_REDIRECT control-flow error, so calling it within the
  // try would let the bare catch swallow it and fall through to notFound(),
  // hard-404ing every valid slug.
  let destination: string | null = null;

  try {
    const { getToken } = await auth();
    const token = await getToken();

    if (token) {
      const response = await fetch(
        `${resolveApiOrigin()}/documents/by-slug/${encodeURIComponent(slug)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (response.ok) {
        const result = await response.json();
        if (result.success && result.data) {
          const artifact = result.data;
          const routePrefix = getRoutePrefixForType(artifact.type);

          if (routePrefix && artifact.slug) {
            destination = `/${orgSlug}/${routePrefix}/${artifact.slug}`;
          }
        }
      }
    }
  } catch {
    // Fall through to notFound
  }

  if (destination) {
    redirect(destination);
  }

  notFound();
}
