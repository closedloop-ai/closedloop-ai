import { ArtifactType, withDb } from "@repo/database";
import { NextResponse } from "next/server";

type RouteParams = { params: Promise<{ slug: string }> };

/**
 * Public endpoint returning title, type, and status for a given document slug.
 * Consumed by OG-metadata generation (apps/app/lib/og-metadata.ts) for PRD,
 * plan, and feature pages. No authentication required.
 */
export async function GET(_: Request, { params }: RouteParams) {
  const { slug } = await params;

  const artifact = await withDb((db) =>
    db.artifact.findFirst({
      where: { slug, type: ArtifactType.DOCUMENT },
      select: { name: true, subtype: true, status: true },
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
