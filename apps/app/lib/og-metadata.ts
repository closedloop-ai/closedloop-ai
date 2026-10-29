import {
  ARTIFACT_STATUS_UNKNOWN_LABEL,
  lookupStatusLabel,
} from "@repo/api/src/types/artifact-status-display";
import {
  DOCUMENT_ROUTE_PREFIX,
  DocumentType,
  LEGACY_TYPE_ROUTE_PREFIXES,
} from "@repo/api/src/types/document";
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

const DOCUMENT_OG_PATH_PREFIXES = [
  DOCUMENT_ROUTE_PREFIX,
  ...Object.values(LEGACY_TYPE_ROUTE_PREFIXES).flat(),
];
const DOCUMENT_OG_PATH_PATTERN = new RegExp(
  String.raw`^(?:([^/]+)\/)?(?:${DOCUMENT_OG_PATH_PREFIXES.join("|")})\/([^/]+)$`
);

/**
 * OG metadata handler registry.
 *
 * Each handler matches a URL path pattern and fetches metadata from the
 * appropriate API endpoint. Patterns support an optional org-slug prefix
 * so both `documents/PRD-1` and `acme/documents/PRD-1` match. When an org slug
 * is present, it's forwarded to the meta endpoint for org-scoped lookup.
 */
const handlers: OgHandler[] = [
  {
    // ISS-12855: every document unfurls from `/documents/:slug`; the legacy
    // per-type prefixes are still matched because Clerk's `redirect_url` and the
    // Slackbot `/features` rewrite still carry them.
    pattern: DOCUMENT_OG_PATH_PATTERN,
    async resolve(match, apiUrl) {
      const orgSlug = match[1];
      const slug = match[2];
      const data = await fetchJson(buildMetaUrl(apiUrl, slug, orgSlug));
      // A Template has no detail page (PRD-799), so its link must not unfurl
      // as a real page that then renders not-found.
      if (!data || data.type === DocumentType.Template) {
        return FALLBACK_METADATA;
      }
      if (data.type === DocumentType.Feature) {
        return makeMetadata(data.title, issueOgDescription(data.status));
      }
      const description =
        DOCUMENT_TYPE_BADGE_LABELS[data.type as DocumentType] ?? data.type;
      return makeMetadata(data.title, description);
    },
  },
];

function issueOgDescription(status: string | undefined): string {
  const typeLabel = DOCUMENT_TYPE_BADGE_LABELS[DocumentType.Feature];
  // ISS-9560: a status with no label entry, or none at all, now reads
  // "Unknown". The old chain printed the raw wire token and then fell
  // through to the TYPE label, so a status-less issue unfurled to Slack and
  // Linear as "Issue, Issue" — the type stated twice, and nothing about the
  // status. UNGATED, unlike the in-app surfaces: this is a server module
  // with no flag seam, and restoring the intended behavior of a broken
  // fallback is a bug fix.
  const description =
    lookupStatusLabel(ARTIFACT_STATUS_LABELS, status) ??
    ARTIFACT_STATUS_UNKNOWN_LABEL;
  // Comma, not an em dash: this unfurl copy ships to Slack/Linear previews
  // for every issue link, and we don't ship em dashes in customer-facing copy.
  return `${typeLabel}, ${description}`;
}

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
