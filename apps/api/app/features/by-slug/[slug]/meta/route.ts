import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { featuresService } from "../../../service";

type RouteParams = { params: Promise<{ slug: string }> };

/**
 * Public endpoint returning only feature title and status for a given feature slug.
 * No authentication required. Used by the OG metadata handler for link previews.
 */
export async function GET(_: Request, { params }: RouteParams) {
  const { slug } = await params;

  try {
    const feature = await featuresService.findMetaBySlug(slug);

    if (!feature) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json(feature);
  } catch (error) {
    log.error("[features/meta] Failed to fetch feature metadata", {
      slug,
      error,
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
