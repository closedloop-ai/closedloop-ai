import type { ArtifactSubtype } from "@repo/api/src/types/artifact";
import { notFound, redirect } from "next/navigation";

/**
 * Catch-all artifact redirect route.
 * Resolves a document slug to the correct type-specific route.
 *
 * This route exists as a fallback for Liveblocks inbox notification URLs
 * when room metadata is missing (fire-and-forget room creation).
 * The resolver tries to build type-specific URLs, but falls back to
 * /artifacts/:slug which lands here and redirects appropriately.
 */

const ARTIFACT_TYPE_ROUTES: Partial<Record<ArtifactSubtype, string>> = {
  PRD: "prds",
  IMPLEMENTATION_PLAN: "implementation-plans",
  IMPLEMENTATION_STRATEGY: "implementation-plans",
  ISSUE: "issues",
  BUG: "issues",
};

type ArtifactPageProps = {
  params: Promise<{ slug: string }>;
};

export default async function ArtifactRedirectPage({
  params,
}: ArtifactPageProps) {
  const { slug } = await params;

  // Try to find the artifact by slug via the API
  try {
    const { auth } = await import("@repo/auth/server");
    const { getToken } = await auth();
    const token = await getToken();

    if (!token) {
      notFound();
    }

    const { env } = await import("@/env");
    const response = await fetch(
      `${env.NEXT_PUBLIC_API_URL}/artifacts?documentSlug=${encodeURIComponent(slug)}&latestOnly=true`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (response.ok) {
      const result = await response.json();
      if (result.success && result.data?.length > 0) {
        const artifact = result.data[0];
        const routePrefix =
          ARTIFACT_TYPE_ROUTES[artifact.subtype as ArtifactSubtype];

        if (routePrefix && artifact.documentSlug) {
          redirect(`/${routePrefix}/${artifact.documentSlug}`);
        }
      }
    }
  } catch {
    // Fall through to notFound
  }

  notFound();
}
