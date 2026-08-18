import type { DocumentDetail } from "@repo/api/src/types/document";
import {
  DocumentType,
  getRoutePrefixForType,
} from "@repo/api/src/types/document";
import { auth } from "@repo/auth/server";
import { notFound, redirect } from "next/navigation";
import { resolveApiOrigin } from "@/lib/api-origin";
import { DocumentEditorContainer } from "./document-editor-container";

/**
 * The `/documents/[slug]` route serves two roles (ISS-4382):
 *
 * 1. **DOC editor** — for an org-level Document (DocumentType.Doc), it renders
 *    the reusable document editor in place. This is the detail/editor page that
 *    makes DOC rows on the Documents index navigable and gives the create flow
 *    somewhere to land.
 * 2. **Artifact-slug redirect fallback** — for any other document type, it
 *    resolves the slug to that type's own detail route and redirects there.
 *    This preserves the pre-existing behavior for Liveblocks inbox notification
 *    URLs, which fire-and-forget room creation and can point here when room
 *    metadata is missing.
 *
 * The artifact is resolved once, server-side, so the DOC-vs-redirect decision
 * happens before any editor mounts.
 */

type DocumentPageProps = {
  params: Promise<{ orgSlug: string; slug: string }>;
  searchParams: Promise<{ version?: string }>;
};

/**
 * `GET /documents/by-slug/:slug` returns the full {@link DocumentDetail} (its
 * documented contract). We resolve it once server-side both to make the
 * DOC-vs-redirect routing decision *and* to hand the already-fetched detail to
 * the client editor as hydration, so the DOC editor does not issue a second
 * identical by-slug request on mount (avoiding a serial two-request waterfall).
 */
async function resolveDocumentBySlug(
  slug: string
): Promise<DocumentDetail | null> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) {
    return null;
  }

  const response = await fetch(
    `${resolveApiOrigin()}/documents/by-slug/${encodeURIComponent(slug)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }
  );

  // A genuine not-found maps to the route's own notFound()/redirect handling
  // below. Every other non-OK response (5xx, auth, rate-limit) is a *transient*
  // failure, not a missing document — let it throw so the route error boundary
  // renders instead of lying with a permanent 404. A network throw likewise
  // propagates for the same reason.
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `Failed to resolve document by slug (status ${response.status})`
    );
  }

  const result = await response.json();
  if (result.success && result.data) {
    return result.data as DocumentDetail;
  }
  return null;
}

/** A `?version` must be a whole positive integer — reject "2junk", "2.5", etc. */
const VERSION_PARAM_PATTERN = /^\d+$/;

/**
 * Parse a `?version` search param to a positive integer, or `undefined` when it
 * is absent or invalid. Validation matches the API's whole-number/integer
 * contract: `parseInt` alone would accept "2junk" and "2.5" as 2, so the string
 * is first checked to be all digits. An invalid value falls back to the latest
 * version rather than 404ing, so a junk param on a document that exists never
 * tells the user it does not.
 */
function parseVersionParam(version?: string): number | undefined {
  if (!(version && VERSION_PARAM_PATTERN.test(version))) {
    return;
  }
  const parsed = Number.parseInt(version, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return;
  }
  return parsed;
}

export default async function DocumentPage({
  params,
  searchParams,
}: Readonly<DocumentPageProps>) {
  const { orgSlug, slug } = await params;
  const { version } = await searchParams;
  // The path this route is mounted at; used to detect a would-be self-redirect.
  const currentPath = `/${orgSlug}/documents/${slug}`;

  const artifact = await resolveDocumentBySlug(slug);

  // A DOC subtype renders the editor here — this is its home route. Route the
  // decision before touching redirect() so the NEXT_REDIRECT control-flow throw
  // (see below) can never be reached for a DOC.
  if (artifact?.type === DocumentType.Doc) {
    // Ignore an unparseable/out-of-range `?version` and fall back to the latest
    // version rather than 404ing — a junk param on a document that genuinely
    // exists must not tell the user it doesn't. This is the first surface where
    // a user lands on a doc they just created and could round-trip a stale
    // param. A concrete but non-existent version is still surfaced downstream by
    // the by-slug fetch (a real 404 from the API), not swallowed here.
    const versionNumber = parseVersionParam(version);
    // Key by slug + resolved version so navigating between ?version values on
    // the same slug remounts the container and re-seeds its internal version
    // selector from the URL, instead of leaving `useState(initialVersion)`
    // pinned to the first-mount value (React's "reset state when a prop
    // changes" pattern; see apps/app/AGENTS.md).
    return (
      <DocumentEditorContainer
        initialDocument={artifact}
        key={`${slug}:${versionNumber ?? "latest"}`}
        slug={slug}
        version={versionNumber}
      />
    );
  }

  // Non-DOC artifacts resolve to their own type-specific route. Compute the
  // destination first and call redirect() *outside* the resolution above:
  // redirect() throws a NEXT_REDIRECT control-flow error, so calling it inside
  // the try/catch in resolveArtifactBySlug would swallow it and hard-404.
  let destination: string | null = null;
  if (artifact?.slug && artifact.type) {
    const routePrefix = getRoutePrefixForType(artifact.type);
    if (routePrefix) {
      const candidate = `/${orgSlug}/${routePrefix}/${artifact.slug}`;
      // Only redirect to a *different* route; a prefix that resolves back to
      // this same path would loop.
      if (candidate !== currentPath) {
        destination = candidate;
      }
    }
  }

  if (destination) {
    redirect(destination);
  }

  notFound();
}
