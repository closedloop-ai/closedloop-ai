import type { Metadata } from "next";

const ARTIFACT_TYPE_DISPLAY: Record<string, string> = {
  PRD: "Product Requirements Document",
  ISSUE: "Issue",
  BUG: "Bug Report",
  IMPLEMENTATION_PLAN: "Implementation Plan",
  IMPLEMENTATION_STRATEGY: "Implementation Strategy",
};

/**
 * Fetches artifact metadata from the public API endpoint and returns
 * Next.js Metadata with proper OG tags for link previews.
 */
export async function generateArtifactMetadata(
  slug: string
): Promise<Metadata> {
  try {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3002";
    const res = await fetch(`${apiUrl}/artifacts/by-slug/${slug}/meta`, {
      next: { revalidate: 60 },
    });

    if (!res.ok) {
      return { title: "ClosedLoop.ai" };
    }

    const { title, type } = (await res.json()) as {
      title: string;
      type: string;
    };
    const typeLabel = ARTIFACT_TYPE_DISPLAY[type] ?? type;

    return {
      title: `${title} | ClosedLoop.ai`,
      description: typeLabel,
      openGraph: {
        title: `${title} | ClosedLoop.ai`,
        description: typeLabel,
        type: "website",
        siteName: "ClosedLoop.ai",
      },
    };
  } catch {
    return { title: "ClosedLoop.ai" };
  }
}
