import { getRoutePrefixForType } from "@repo/api/src/types/artifact";
import { auth } from "@repo/auth/server";
import { notFound, redirect } from "next/navigation";
import { env } from "@/env";

/**
 * Catch-all artifact redirect route.
 * Resolves an artifact slug to the correct type-specific route.
 *
 * This route exists as a fallback for Liveblocks inbox notification URLs
 * when room metadata is missing (fire-and-forget room creation).
 * The resolver tries to build type-specific URLs, but falls back to
 * /artifacts/:slug which lands here and redirects appropriately.
 */

type ArtifactPageProps = {
  params: Promise<{ slug: string }>;
};

export default async function ArtifactRedirectPage({
  params,
}: ArtifactPageProps) {
  const { slug } = await params;

  // Try to find the artifact by slug via the API
  try {
    const { getToken } = await auth();
    const token = await getToken();

    if (!token) {
      notFound();
    }

    const response = await fetch(
      `${env.NEXT_PUBLIC_API_URL}/artifacts/by-slug/${encodeURIComponent(slug)}`,
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
          redirect(`/${routePrefix}/${artifact.slug}`);
        }
      }
    }
  } catch {
    // Fall through to notFound
  }

  notFound();
}
