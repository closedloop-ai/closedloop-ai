import { auth } from "@repo/auth/server";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { docsCorpusFailureReason } from "@/lib/docs-help/docs-corpus";
import { docsCorpus } from "@/lib/docs-help/docs-corpus-cache";

/**
 * GET /api/docs-help/page?path=<pageId> — one page, with its markdown body.
 *
 * ISS-10006. Web's replacement for desktop's `docsHelp.getPage`. The three
 * outcomes are kept apart because the surface renders three different things:
 * 404 is "the corpus has no such page" (`page: missing`), 503 is "the read did
 * not come back" (`page: error`), and only 200 is a page. Collapsing the first
 * two sends a reader looking online for a page that is sitting in the build.
 */
const HTTP_SERVICE_UNAVAILABLE = 503;

export async function GET(request: Request): Promise<Response> {
  const { userId } = await auth();
  if (!userId) {
    return new Response("Unauthorized", { status: 401 });
  }
  const requested = new URL(request.url).searchParams.get("path");
  if (requested === null || requested === "") {
    return new Response("Missing path", { status: 400 });
  }
  try {
    const page = docsCorpus().pages.find(
      (candidate) => candidate.path === requested
    );
    if (page === undefined) {
      return new Response("No such page", { status: 404 });
    }
    return NextResponse.json({ page });
  } catch (error) {
    log.error("docs-help page read failed", { error: parseError(error) });
    // The BODY carries which of the two failures this was, so the reader is not
    // told to wait for a corpus that this deployment never shipped. An older
    // client ignores it and keeps the generic sentence.
    return NextResponse.json(
      { reason: docsCorpusFailureReason(error) },
      { status: HTTP_SERVICE_UNAVAILABLE }
    );
  }
}
