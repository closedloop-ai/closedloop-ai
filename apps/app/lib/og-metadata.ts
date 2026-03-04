import { ArtifactType } from "@repo/api/src/types/artifact";
import type { IssueStatus } from "@repo/api/src/types/issue";
import type { Metadata } from "next";
import { env } from "@/env";
import { ISSUE_STATUS_LABELS } from "@/lib/project-constants";

const ARTIFACT_TYPE_DISPLAY: Record<ArtifactType, string> = {
  [ArtifactType.Prd]: "PRD",
  [ArtifactType.ImplementationPlan]: "Plan",
  [ArtifactType.Template]: "Template",
};

const FALLBACK_METADATA: Metadata = {
  title: "ClosedLoop.ai",
  openGraph: {
    title: "ClosedLoop.ai",
    description: "Sign in to view this content.",
    type: "website",
    siteName: "ClosedLoop.ai",
  },
  twitter: {
    card: "summary",
    title: "ClosedLoop.ai",
    description: "Sign in to view this content.",
  },
};

function makeMetadata(title: string, description: string): Metadata {
  const fullTitle = `${title} | ClosedLoop.ai`;
  return {
    title: fullTitle,
    description,
    openGraph: {
      title: fullTitle,
      description,
      type: "website",
      siteName: "ClosedLoop.ai",
    },
    twitter: {
      card: "summary",
      title: fullTitle,
      description,
    },
  };
}

async function fetchJson(url: string): Promise<Record<string, string> | null> {
  try {
    const res = await fetch(url, { next: { revalidate: 60 } });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as Record<string, string>;
  } catch {
    return null;
  }
}

type OgHandler = {
  pattern: RegExp;
  resolve: (match: RegExpExecArray, apiUrl: string) => Promise<Metadata>;
};

/**
 * OG metadata handler registry.
 *
 * Each handler matches a URL path pattern and fetches metadata from the
 * appropriate API endpoint. To add OG support for a new page:
 * 1. Add a public `/meta` API endpoint for the entity (no auth required)
 * 2. Add a handler entry here with the path pattern and fetch logic
 */
const handlers: OgHandler[] = [
  {
    pattern: /^(?:prds|implementation-plans|artifacts)\/([^/]+)$/,
    async resolve(match, apiUrl) {
      const slug = match[1];
      const data = await fetchJson(`${apiUrl}/artifacts/by-slug/${slug}/meta`);
      if (!data) {
        return FALLBACK_METADATA;
      }
      const description =
        ARTIFACT_TYPE_DISPLAY[data.type as ArtifactType] ?? data.type;
      return makeMetadata(data.title, description);
    },
  },
  {
    pattern: /^issues\/([^/]+)$/,
    async resolve(match, apiUrl) {
      const slug = match[1];
      const data = await fetchJson(`${apiUrl}/issues/by-slug/${slug}/meta`);
      if (!data) {
        return FALLBACK_METADATA;
      }
      const description =
        ISSUE_STATUS_LABELS[data.status as IssueStatus] ??
        data.status ??
        "Issue";
      return makeMetadata(data.title, `Issue — ${description}`);
    },
  },
];

/**
 * Resolves OG metadata for a given path.
 * Used by the sign-in page (for redirect_url) and authenticated page generateMetadata.
 */
export async function resolveOgMetadata(path: string): Promise<Metadata> {
  const apiUrl = env.NEXT_PUBLIC_API_URL ?? "http://localhost:3002";

  for (const handler of handlers) {
    const match = handler.pattern.exec(path);
    if (match) {
      return await handler.resolve(match, apiUrl);
    }
  }

  return FALLBACK_METADATA;
}
