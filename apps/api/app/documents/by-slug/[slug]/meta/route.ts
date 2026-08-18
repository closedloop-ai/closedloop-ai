import type {
  ArtifactSubtype,
  ArtifactSubtypeInput,
} from "@repo/api/src/types/artifact";
import { normalizeArtifactSubtype } from "@repo/api/src/types/artifact";
import { expandSlugAliases } from "@repo/api/src/types/slug-prefix";
import { ArtifactType, withDb } from "@repo/database";
import { NextResponse } from "next/server";

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
 * plan, and feature pages. No authentication required.
 *
 * When `?org=<orgSlug>` is provided, scopes the lookup by organization
 * using the compound unique index (organizationId, slug). Without the
 * param, falls back to an unscoped findFirst for backward compatibility.
 */
export async function GET(request: Request, { params }: RouteParams) {
  const { slug } = await params;
  const orgSlug = new URL(request.url).searchParams.get("org");

  if (orgSlug) {
    const org = await withDb((db) =>
      db.organization.findUnique({ where: { slug: orgSlug } })
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
