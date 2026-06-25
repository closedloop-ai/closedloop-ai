import type { DocumentStatus } from "@repo/api/src/types/document";
import { DocumentType } from "@repo/api/src/types/document";
import { DOCUMENT_STATUS_LABELS } from "@repo/app/projects/lib/project-constants";
import type { Metadata } from "next";
import { env } from "@/env";

const DOCUMENT_TYPE_DISPLAY: Record<DocumentType, string> = {
  [DocumentType.Prd]: "PRD",
  [DocumentType.ImplementationPlan]: "Plan",
  [DocumentType.Template]: "Template",
  [DocumentType.Feature]: "Feature",
};

const FALLBACK_METADATA: Metadata = {
  title: "Closedloop.ai",
  openGraph: {
    title: "Closedloop.ai",
    description: "Sign in to view this content.",
    type: "website",
    siteName: "Closedloop.ai",
  },
  twitter: {
    card: "summary",
    title: "Closedloop.ai",
    description: "Sign in to view this content.",
  },
};

function makeMetadata(title: string, description: string): Metadata {
  const fullTitle = `${title} | Closedloop.ai`;
  return {
    title: fullTitle,
    description,
    openGraph: {
      title: fullTitle,
      description,
      type: "website",
      siteName: "Closedloop.ai",
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

function buildMetaUrl(
  apiUrl: string,
  slug: string,
  orgSlug: string | undefined
): string {
  const base = `${apiUrl}/documents/by-slug/${slug}/meta`;
  return orgSlug ? `${base}?org=${encodeURIComponent(orgSlug)}` : base;
}

/**
 * OG metadata handler registry.
 *
 * Each handler matches a URL path pattern and fetches metadata from the
 * appropriate API endpoint. Patterns support an optional org-slug prefix
 * so both `prds/PRD-1` and `acme/prds/PRD-1` match. When an org slug is
 * present, it's forwarded to the meta endpoint for org-scoped lookup.
 */
const handlers: OgHandler[] = [
  {
    pattern: /^(?:([^/]+)\/)?(?:prds|implementation-plans|documents)\/([^/]+)$/,
    async resolve(match, apiUrl) {
      const orgSlug = match[1];
      const slug = match[2];
      const data = await fetchJson(buildMetaUrl(apiUrl, slug, orgSlug));
      if (!data) {
        return FALLBACK_METADATA;
      }
      const description =
        DOCUMENT_TYPE_DISPLAY[data.type as DocumentType] ?? data.type;
      return makeMetadata(data.title, description);
    },
  },
  {
    pattern: /^(?:([^/]+)\/)?features\/([^/]+)$/,
    async resolve(match, apiUrl) {
      const orgSlug = match[1];
      const slug = match[2];
      const data = await fetchJson(buildMetaUrl(apiUrl, slug, orgSlug));
      if (!data) {
        return FALLBACK_METADATA;
      }
      const description =
        DOCUMENT_STATUS_LABELS[data.status as DocumentStatus] ??
        data.status ??
        "Feature";
      return makeMetadata(data.title, `Feature — ${description}`);
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
