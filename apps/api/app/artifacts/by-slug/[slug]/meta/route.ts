import { withDb } from "@repo/database";
import { NextResponse } from "next/server";

type RouteParams = { params: Promise<{ slug: string }> };

/**
 * Public endpoint returning only artifact title and type for a given documentSlug.
 * No authentication required — the slug is a random nanoid(14) that acts as a
 * share token. Used by generateMetadata() so link previews (Slack, social media)
 * show the actual artifact title instead of generic branding.
 */
export async function GET(_request: Request, { params }: RouteParams) {
  const { slug } = await params;

  const artifact = await withDb((db) =>
    db.artifact.findFirst({
      where: { slug },
      select: { title: true, type: true },
    })
  );

  if (!artifact) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(artifact);
}
