import type {
  ArtifactSubtype,
  ArtifactSubtypeInput,
} from "@repo/api/src/types/artifact";
import { normalizeArtifactSubtype } from "@repo/api/src/types/artifact";
import { expandSlugAliases } from "@repo/api/src/types/slug-prefix";
import { ArtifactType, withDb } from "@repo/database";
import { NextResponse } from "next/server";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";

type RouteParams = { params: Promise<{ slug: string }> };

const ARTIFACT_SELECT = { name: true, subtype: true, status: true } as const;

// FEA-3956: normalize the persisted subtype to its canonical value before it
// reaches the wire. Rows never store the canonical `ISSUE` (map-in-code,
// PRD-560 dec. 2), but the widened Prisma enum permits it, so a version-skewed
// direct write could land an `ISSUE` row; mapping keeps that resolving to
// `FEATURE` instead of leaking an out-of-contract subtype to unfurl consumers.
// The Prisma-generated `ArtifactSubtype` (which now includes `ISSUE`) is the
// `ArtifactSubtypeInput` superset the normalizer accepts.
function normalizeSubtypeForWire(
  subtype: ArtifactSubtypeInput | null
): ArtifactSubtype | null {
  return subtype ? normalizeArtifactSubtype(subtype) : null;
}

/**
 * Public endpoint returning title, type, and status for a given document slug.
 * Consumed by OG-metadata generation (apps/app/lib/og-metadata.ts) for PRD,
 * plan, and feature pages.
 *
 * This route takes no auth, and whether it SHOULD is OPEN under ISS-6916 — not
 * settled here in either direction. The link-preview crawlers this exists for
 * carry no session, so the posture is at least deliberate-looking; against that,
 * it returns a document's title, type and status to anyone who can guess a slug,
 * and adding auth would break every current caller. That trade is a human's
 * call, not an implementation lane's. (Note for whoever makes it: the three
 * not-found branches all return an identical `{ error: "Not found" }` 404, so
 * there is no response-shape oracle distinguishing an unknown org from a known
 * org with no such document — only a timing one, one query versus two.)
 *
 * Until that decision is made, the org read below stays narrowed to the id it
 * resolves (ISS-6325), and the `no-unauthenticated-org-read` source gate fails
 * the build if anyone widens it.
 *
 * When `?org=<orgSlug>` is provided, scopes the lookup by organization
 * using the compound unique index (organizationId, slug). Without the
 * param, falls back to an unscoped findFirst for backward compatibility.
 */
async function handleGet(request: Request, { params }: RouteParams) {
  const { slug } = await params;
  const orgSlug = new URL(request.url).searchParams.get("org");

  if (orgSlug) {
    const org = await withDb((db) =>
      // Unauthenticated route: read the id it resolves and nothing else, so the
      // org's encrypted Claude API key and settings blob never enter this
      // process on a public unfurl.
      db.organization.findUnique({
        where: { slug: orgSlug },
        select: { id: true },
      })
    );

    if (!org) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // FEA-4137: `ISS-###` and `FEA-###` are the same numeric identity, so an
    // alias-form Issue unfurl must resolve the stored row under either prefix.
    // findFirst over the alias set (one row per identity) instead of the
    // compound-unique findUnique on the literal slug.
    const artifact = await withDb((db) =>
      db.artifact.findFirst({
        where: {
          organizationId: org.id,
          slug: { in: expandSlugAliases(slug) },
          type: ArtifactType.DOCUMENT,
        },
        select: ARTIFACT_SELECT,
      })
    );

    if (!artifact) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({
      title: artifact.name,
      type: normalizeSubtypeForWire(artifact.subtype),
      status: artifact.status,
    });
  }

  const artifact = await withDb((db) =>
    db.artifact.findFirst({
      where: {
        slug: { in: expandSlugAliases(slug) },
        type: ArtifactType.DOCUMENT,
      },
      select: ARTIFACT_SELECT,
    })
  );

  if (!artifact) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    title: artifact.name,
    type: normalizeSubtypeForWire(artifact.subtype),
    status: artifact.status,
  });
}

export const GET = withRequestCompleted(handleGet);
