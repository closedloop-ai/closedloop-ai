import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { NextRequest } from "next/server";
import { findFirstExistingPath } from "@/lib/engineer/process-utils";
import { expandHome, getWorktreeParentDir } from "@/lib/engineer/repos";

/**
 * GET /api/symphony/learnings-status/[ticketId]?repo=...
 *
 * Returns the status of the most recent learning extraction for a ticket.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  const { ticketId } = await params;
  const searchParams = request.nextUrl.searchParams;
  const repoPath = searchParams.get("repo");

  if (!repoPath) {
    return new Response(
      JSON.stringify({ error: "repo parameter is required" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const expandedRepoPath = expandHome(repoPath);
  const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const repoName = basename(expandedRepoPath);
  const worktreeParentDir = getWorktreeParentDir();
  const worktreeDir = join(worktreeParentDir, `${repoName}-${sanitizedTicket}`);
  const statusPath = findFirstExistingPath(
    join(
      worktreeDir,
      ".closedloop-ai",
      "work",
      ".learnings",
      "chat-extraction-status.json"
    ),
    join(
      worktreeDir,
      ".claude",
      "work",
      ".learnings",
      "chat-extraction-status.json"
    )
  );

  if (!statusPath) {
    return Response.json({ status: "none", count: 0 });
  }

  try {
    const content = readFileSync(statusPath, "utf-8");
    const status = JSON.parse(content);
    return Response.json(status);
  } catch {
    return Response.json({ status: "none", count: 0 });
  }
}
