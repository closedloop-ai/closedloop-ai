import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { NextRequest } from "next/server";
import { triggerAsyncLearningExtraction } from "@/lib/engineer/learnings";
import { expandHome, getWorktreeParentDir } from "@/lib/engineer/repos";

/**
 * POST /api/symphony/extract-learnings
 *
 * Triggers async learning extraction from a chat session.
 * Called by the /reflect command or automatically after file-editing chats.
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { ticketId, repoPath, activeTab, chatFile } = body as {
    ticketId: string;
    repoPath: string;
    activeTab?: string;
    /** Relative path within .claude/work/ to the chat file to analyze.
     *  e.g. "chat-history.json" or "comment-chats/{commentId}.json".
     *  Defaults to "chat-history.json" if not provided. */
    chatFile?: string;
  };

  if (!(ticketId && repoPath)) {
    return new Response(
      JSON.stringify({ error: "ticketId and repoPath are required" }),
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
  const claudeWorkDir = join(worktreeDir, ".claude", "work");
  const chatHistoryPath = join(claudeWorkDir, chatFile || "chat-history.json");

  if (!existsSync(worktreeDir)) {
    return new Response(JSON.stringify({ error: "Work directory not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!existsSync(chatHistoryPath)) {
    return new Response(
      JSON.stringify({
        error: "No chat history found",
        path: chatFile || "chat-history.json",
      }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  triggerAsyncLearningExtraction({
    symphonyWorkDir: claudeWorkDir,
    worktreeDir,
    chatHistoryPath,
    activeTab,
    ticketId: sanitizedTicket,
  });

  return Response.json({ status: "processing" });
}
