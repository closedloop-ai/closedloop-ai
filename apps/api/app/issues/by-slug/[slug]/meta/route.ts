import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { issuesService } from "../../service";

type RouteParams = { params: Promise<{ slug: string }> };

/**
 * Public endpoint returning only issue title and status for a given issue slug.
 * No authentication required. Used by the OG metadata handler for link previews.
 */
export async function GET(_: Request, { params }: RouteParams) {
  const { slug } = await params;

  try {
    const issue = await issuesService.findMetaBySlug(slug);

    if (!issue) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json(issue);
  } catch (error) {
    log.error("[issues/meta] Failed to fetch issue metadata", { slug, error });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
