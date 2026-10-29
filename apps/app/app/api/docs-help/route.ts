import { auth } from "@repo/auth/server";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { docsCorpusFailureReason } from "@/lib/docs-help/docs-corpus";
import { docsCorpus } from "@/lib/docs-help/docs-corpus-cache";

/**
 * GET /api/docs-help — the nav tree, and only the nav tree.
 *
 * ISS-10006. Web's replacement for desktop's `docsHelp.status` + `docsHelp.nav`
 * IPC pair. The corpus is 155 pages and ~1.3MB of markdown, and the reader opens
 * one page at a time, so nothing but the tree crosses here — the page read and
 * the search are their own routes precisely so this one stays small.
 *
 * A failure here is what the surface renders as `bundleStatus: Unavailable`. It
 * must stay distinguishable from an empty tree — a 200 with `navGroups: []`
 * would tell the reader the docs set has no pages, which is a claim about the
 * corpus that a failed read supports in no way.
 */
const HTTP_SERVICE_UNAVAILABLE = 503;

export async function GET(): Promise<Response> {
  const { userId } = await auth();
  if (!userId) {
    return new Response("Unauthorized", { status: 401 });
  }
  try {
    return NextResponse.json({ navGroups: docsCorpus().navGroups });
  } catch (error) {
    log.error("docs-help nav read failed", { error: parseError(error) });
    // The BODY carries which of the two failures this was, so the reader is not
    // told to wait for a corpus that this deployment never shipped. An older
    // client ignores it and keeps the generic sentence.
    return NextResponse.json(
      { reason: docsCorpusFailureReason(error) },
      { status: HTTP_SERVICE_UNAVAILABLE }
    );
  }
}
