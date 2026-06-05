import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { NextRequest } from "next/server";
import { triggerAsyncLearningExtraction } from "@/lib/engineer/learnings";
import {
  expandHome,
  getWorktreeParentDir,
  isRepoAllowed,
} from "@/lib/engineer/repos";

/**
 * POST /api/engineer/symphony/extract-learnings
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
    /** Relative path within .closedloop-ai/work/ to the chat file to analyze.
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

  if (!isRepoAllowed(repoPath)) {
    return new Response(
      JSON.stringify({ error: `Repository not allowed: ${repoPath}` }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  const expandedRepoPath = expandHome(repoPath);
  const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const repoName = basename(expandedRepoPath);
  const worktreeParentDir = getWorktreeParentDir();
  const worktreeDir = join(worktreeParentDir, `${repoName}-${sanitizedTicket}`);
  if (!existsSync(worktreeDir)) {
    return new Response(JSON.stringify({ error: "Work directory not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const claudeWorkDir = join(worktreeDir, ".closedloop-ai", "work");
  const chatFilename = chatFile || "chat-history.json";
  const chatHistoryPath = join(claudeWorkDir, chatFilename);

  if (!existsSync(chatHistoryPath)) {
    return new Response(
      JSON.stringify({
        error: "No chat history found",
        path: chatFilename,
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
