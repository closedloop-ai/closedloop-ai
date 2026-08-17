import { DocumentType } from "@repo/api/src/types/document";
import { DOCUMENT_TYPE_BADGE_LABELS } from "@repo/app/documents/lib/document-type-labels";
import { ARTIFACT_STATUS_LABELS } from "@repo/app/projects/lib/project-constants";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { resolveApiOrigin } from "@/lib/api-origin";

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
        DOCUMENT_TYPE_BADGE_LABELS[data.type as DocumentType] ?? data.type;
      return makeMetadata(data.title, description);
    },
  },
  {
    // FEA-4137: Issues live at /issues/; /features/ is the retired alias path,
    // still matched so link-unfurl previews resolve for old bookmarks/links.
    pattern: /^(?:([^/]+)\/)?(?:issues|features)\/([^/]+)$/,
    async resolve(match, apiUrl) {
      const orgSlug = match[1];
      const slug = match[2];
      const data = await fetchJson(buildMetaUrl(apiUrl, slug, orgSlug));
      if (!data) {
        return FALLBACK_METADATA;
      }
      const typeLabel = DOCUMENT_TYPE_BADGE_LABELS[DocumentType.Feature];
      const description =
        ARTIFACT_STATUS_LABELS[data.status] ?? data.status ?? typeLabel;
      // Comma, not an em dash: this unfurl copy ships to Slack/Linear previews
      // for every /issues/ link, and we don't ship em dashes in customer-facing
      // copy.
      return makeMetadata(data.title, `${typeLabel}, ${description}`);
    },
  },
];

/**
 * Resolves OG metadata for a given path.
 * Used by the auth pages (for redirect_url) and authenticated page generateMetadata.
 */
export async function resolveOgMetadata(path: string): Promise<Metadata> {
  // Server-side BFF call: resolveApiOrigin honors SERVER_API_URL so the app
  // container reaches the api container instead of its own localhost.
  const apiUrl = resolveApiOrigin();

  for (const handler of handlers) {
    const match = handler.pattern.exec(path);
    if (match) {
      return await handler.resolve(match, apiUrl);
    }
  }

  return FALLBACK_METADATA;
}

/**
 * Resolves OG metadata for the page a Clerk auth redirect came from.
 *
 * Unauthenticated requests to protected pages are redirected to an auth page
 * with the original URL in the `redirect_url` query parameter (e.g.
 * /sign-up?redirect_url=https://app.closedloop.ai/acme/features/FEA-1).
 * Link-unfurler bots can't authenticate, so they land on the auth page —
 * resolve the original document's metadata so previews show its real
 * title/description instead of the generic auth-page copy. Falls back to
 * `fallback` when there is no usable same-host redirect target.
 */
export async function resolveOgMetadataFromRedirectUrl(
  redirectUrl: string | string[] | undefined,
  fallback: Metadata
): Promise<Metadata> {
  // Next.js hands repeated query keys through as string[]. A duplicated
  // redirect_url is never a legitimate Clerk redirect, so treat it as absent.
  if (!redirectUrl || Array.isArray(redirectUrl)) {
    return fallback;
  }

  try {
    const parsed = new URL(redirectUrl);
    const headersList = await headers();
    const host = headersList.get("host");

    if (host && parsed.host === host && parsed.pathname.length > 1) {
      return await resolveOgMetadata(parsed.pathname.slice(1));
    }
  } catch {
    // redirect_url is a relative path
    const path = redirectUrl.split("?")[0];
    if (path.startsWith("/") && path.length > 1) {
      return await resolveOgMetadata(path.slice(1));
    }
  }

  return fallback;
}

type AuthPageProps = {
  searchParams: Promise<{ redirect_url?: string | string[] }>;
};

/**
 * Builds the `generateMetadata` implementation shared by the sign-in and
 * sign-up pages: resolve the original document's OG metadata from Clerk's
 * `redirect_url` query parameter, falling back to the page's own metadata
 * when there is no usable redirect target.
 */
export function createAuthPageMetadataGenerator(fallback: Metadata) {
  return async function generateMetadata({
    searchParams,
  }: AuthPageProps): Promise<Metadata> {
    const { redirect_url } = await searchParams;
    return await resolveOgMetadataFromRedirectUrl(redirect_url, fallback);
  };
}
