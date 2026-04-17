import { withDb } from "@repo/database";
import { NextResponse } from "next/server";

type RouteParams = { params: Promise<{ slug: string }> };

/**
 * Public endpoint returning only artifact title and type for a given artifact slug.
 * No authentication required.
 */
export async function GET(_: Request, { params }: RouteParams) {
  const { slug } = await params;

  const artifact = await withDb((db) =>
    db.document.findFirst({
      where: { slug },
      select: { title: true, type: true },
    })
  );

  if (!artifact) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(artifact);
}
