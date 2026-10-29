import { auth } from "@repo/auth/server";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { docsCorpusFailureReason } from "@/lib/docs-help/docs-corpus";
import { docsCorpus } from "@/lib/docs-help/docs-corpus-cache";
import { searchDocsCorpus } from "@/lib/docs-help/docs-search";

/**
 * GET /api/docs-help/search?q=<query> — hits over titles, headings and bodies.
 *
 * ISS-10006. Web's replacement for desktop's `docsHelp.search`. Server-side
 * because the index needs page BODIES, which the nav read deliberately does not
 * ship; searching only what the client already holds would quietly narrow web's
 * search to titles and headings while desktop kept searching the text.
 *
 * A 503 becomes `searchFailed`, never `searchHits: []` — an empty array is the
 * surface's "this query matched nothing", a claim about a corpus nothing
 * searched (ISS-10044).
 */
const HTTP_SERVICE_UNAVAILABLE = 503;

export async function GET(request: Request): Promise<Response> {
  const { userId } = await auth();
  if (!userId) {
    return new Response("Unauthorized", { status: 401 });
  }
  const query = new URL(request.url).searchParams.get("q") ?? "";
  try {
    return NextResponse.json({
      hits: searchDocsCorpus(docsCorpus().pages, query),
    });
  } catch (error) {
    log.error("docs-help search failed", { error: parseError(error) });
    // The BODY carries which of the two failures this was, so the reader is not
    // told to wait for a corpus that this deployment never shipped. An older
    // client ignores it and keeps the generic sentence.
    return NextResponse.json(
      { reason: docsCorpusFailureReason(error) },
      { status: HTTP_SERVICE_UNAVAILABLE }
    );
  }
}
