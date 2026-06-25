import { ArtifactType, withDb } from "@repo/database";
import { NextResponse } from "next/server";

type RouteParams = { params: Promise<{ slug: string }> };

const ARTIFACT_SELECT = { name: true, subtype: true, status: true } as const;

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

    const artifact = await withDb((db) =>
      db.artifact.findUnique({
        where: {
          organizationId_slug: {
            organizationId: org.id,
            slug,
          },
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
      type: artifact.subtype,
      status: artifact.status,
    });
  }

  const artifact = await withDb((db) =>
    db.artifact.findFirst({
      where: { slug, type: ArtifactType.DOCUMENT },
      select: ARTIFACT_SELECT,
    })
  );

  if (!artifact) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    title: artifact.name,
    type: artifact.subtype,
    status: artifact.status,
  });
}
