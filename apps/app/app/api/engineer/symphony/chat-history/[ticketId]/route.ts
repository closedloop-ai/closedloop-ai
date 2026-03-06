import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { expandHome, getWorktreeParentDir } from "@/lib/engineer/repos";

/**
 * Chat message structure
 */
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  sender?: "claude" | "codex";
};

type ChatHistory = {
  messages: ChatMessage[];
  ticketId: string;
  repoPath: string;
  sessionId?: string;
  contextPercent?: number | null;
};

/**
 * Get the chat history file path for a ticket
 */
function getChatHistoryPath(ticketId: string, repoPath: string): string {
  const expandedRepoPath = expandHome(repoPath);

  const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const repoName = basename(expandedRepoPath);
  const worktreeParentDir = getWorktreeParentDir();
  const worktreeDir = join(worktreeParentDir, `${repoName}-${sanitizedTicket}`);

  return join(worktreeDir, ".claude", "work", "chat-history.json");
}

/**
 * GET /api/symphony/chat-history/[ticketId]?repo=...
 *
 * Retrieves the chat history for a ticket
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  const { ticketId } = await params;
  const searchParams = request.nextUrl.searchParams;
  const repoPath = searchParams.get("repo");

  if (!repoPath) {
    return NextResponse.json(
      { error: "repo parameter is required" },
      { status: 400 }
    );
  }

  const historyPath = getChatHistoryPath(ticketId, repoPath);

  // Compute once before any early return — Codex review may have completed
  // even before any chat messages exist (no chat-history.json yet).
  const codexStatePath = join(historyPath, "..", "codex-chat.json");
  const codexSessionExists = existsSync(codexStatePath);

  if (!existsSync(historyPath)) {
    return NextResponse.json({
      messages: [],
      ticketId,
      repoPath,
      codexSessionExists,
    });
  }

  try {
    const content = readFileSync(historyPath, "utf-8");
    const history = JSON.parse(content) as ChatHistory;
    return NextResponse.json({ ...history, codexSessionExists });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to read chat history: ${errorMessage}` },
      { status: 500 }
    );
  }
}

/**
 * POST /api/engineer/symphony/chat-history/[ticketId]?repo=...
 *
 * Appends a message to the chat history
 * Body: { message: ChatMessage }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  const { ticketId } = await params;
  const searchParams = request.nextUrl.searchParams;
  const repoPath = searchParams.get("repo");

  if (!repoPath) {
    return NextResponse.json(
      { error: "repo parameter is required" },
      { status: 400 }
    );
  }

  const body = await request.json();
  const { message, sessionId } = body as {
    message?: ChatMessage;
    sessionId?: string;
  };

  const historyPath = getChatHistoryPath(ticketId, repoPath);

  // Ensure directory exists
  const historyDir = join(historyPath, "..");
  if (!existsSync(historyDir)) {
    mkdirSync(historyDir, { recursive: true });
  }

  // Load existing history or create new
  let history: ChatHistory;
  if (existsSync(historyPath)) {
    try {
      const content = readFileSync(historyPath, "utf-8");
      history = JSON.parse(content) as ChatHistory;
    } catch {
      history = { messages: [], ticketId, repoPath };
    }
  } else {
    history = { messages: [], ticketId, repoPath };
  }

  // Session ID seeding (no message required)
  if (sessionId && !message) {
    history.sessionId = sessionId;
    try {
      writeFileSync(historyPath, JSON.stringify(history, null, 2));
      return NextResponse.json({ success: true, sessionId });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json(
        { error: `Failed to save session ID: ${errorMessage}` },
        { status: 500 }
      );
    }
  }

  if (!(message?.content && message.role)) {
    return NextResponse.json(
      { error: "message with content and role is required" },
      { status: 400 }
    );
  }

  // Append message
  history.messages.push(message);

  // Write back
  try {
    writeFileSync(historyPath, JSON.stringify(history, null, 2));
    return NextResponse.json({ success: true, history });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to save chat history: ${errorMessage}` },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/symphony/chat-history/[ticketId]?repo=...&index=...
 *
 * If index is provided, deletes the message at that position.
 * If index is not provided, clears the entire chat history.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  const { ticketId } = await params;
  const searchParams = request.nextUrl.searchParams;
  const repoPath = searchParams.get("repo");
  const indexParam = searchParams.get("index");

  if (!repoPath) {
    return NextResponse.json(
      { error: "repo parameter is required" },
      { status: 400 }
    );
  }

  const historyPath = getChatHistoryPath(ticketId, repoPath);

  if (!existsSync(historyPath)) {
    return NextResponse.json({
      success: true,
      message: "No history to delete",
    });
  }

  try {
    if (indexParam === null) {
      // Clear entire chat - delete the file
      unlinkSync(historyPath);

      // Also clear the Codex chat session state so the next @codex message
      // starts a fresh session with full context instead of resuming a stale one
      const codexStatePath = join(historyPath, "..", "codex-chat.json");
      if (existsSync(codexStatePath)) {
        unlinkSync(codexStatePath);
      }

      return NextResponse.json({
        success: true,
        message: "Chat history cleared",
      });
    }

    // Delete message at specific index
    const index = Number.parseInt(indexParam, 10);
    if (Number.isNaN(index) || index < 0) {
      return NextResponse.json({ error: "Invalid index" }, { status: 400 });
    }

    const content = readFileSync(historyPath, "utf-8");
    const history = JSON.parse(content) as ChatHistory;

    if (index >= history.messages.length) {
      return NextResponse.json(
        { error: "Index out of bounds" },
        { status: 404 }
      );
    }

    // Remove the message at the exact index
    history.messages.splice(index, 1);

    writeFileSync(historyPath, JSON.stringify(history, null, 2));
    return NextResponse.json({ success: true, history });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to delete: ${errorMessage}` },
      { status: 500 }
    );
  }
}
