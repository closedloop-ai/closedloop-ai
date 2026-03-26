import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import {
  deleteSharedCodexChatState,
  getCodexChatStatePath,
} from "@/lib/engineer/codex-state";
import { VALID_PROVIDERS } from "@/lib/engineer/constants";
import {
  checkLegacyProcessAndMigrate,
  findFirstExistingPath,
} from "@/lib/engineer/process-utils";
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

function resolveWorktreeDir(ticketId: string, repoPath: string): string {
  const expandedRepoPath = expandHome(repoPath);
  const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const repoName = basename(expandedRepoPath);
  const worktreeParentDir = getWorktreeParentDir();
  return join(worktreeParentDir, `${repoName}-${sanitizedTicket}`);
}

function chatHistoryFilename(provider?: string | null): string {
  return provider && VALID_PROVIDERS.has(provider)
    ? `chat-history-${provider}.json`
    : "chat-history.json";
}

/**
 * Get the canonical (new) chat history file path for a ticket.
 * When `provider` is specified (and valid), returns a provider-scoped file
 * (`chat-history-claude.json` / `chat-history-codex.json`) so that each
 * ReviewChatPane gets its own transcript.
 */
function getChatHistoryPath(
  ticketId: string,
  repoPath: string,
  provider?: string | null
): string {
  const worktreeDir = resolveWorktreeDir(ticketId, repoPath);
  return join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    chatHistoryFilename(provider)
  );
}

/**
 * Get the legacy (.claude/work) chat history file path for a ticket.
 */
function getLegacyHistoryPath(
  ticketId: string,
  repoPath: string,
  provider?: string | null
): string {
  const worktreeDir = resolveWorktreeDir(ticketId, repoPath);
  return join(worktreeDir, ".claude", "work", chatHistoryFilename(provider));
}

/**
 * Like getChatHistoryPath but returns the first path that exists on disk,
 * checking the new location first and falling back to the legacy location.
 * Returns the new path as default when neither exists (for consistent writes).
 */
function findChatHistoryPath(
  ticketId: string,
  repoPath: string,
  provider?: string | null
): string {
  const newPath = getChatHistoryPath(ticketId, repoPath, provider);
  const legacyPath = getLegacyHistoryPath(ticketId, repoPath, provider);
  return findFirstExistingPath(newPath, legacyPath) ?? newPath;
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
  const provider = searchParams.get("provider");

  if (!repoPath) {
    return NextResponse.json(
      { error: "repo parameter is required" },
      { status: 400 }
    );
  }

  if (provider && !VALID_PROVIDERS.has(provider)) {
    return NextResponse.json(
      { error: "unsupported provider" },
      { status: 400 }
    );
  }

  const historyPath = findChatHistoryPath(ticketId, repoPath, provider);

  // Compute once before any early return — Codex review may have completed
  // even before any chat messages exist (no chat-history.json yet).
  // Only check the review-scoped session file (ReviewChatPane is the sole consumer).
  const workDir = join(historyPath, "..");
  const codexSessionExists = existsSync(
    getCodexChatStatePath(workDir, "review")
  );

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
  const provider = searchParams.get("provider");

  if (!repoPath) {
    return NextResponse.json(
      { error: "repo parameter is required" },
      { status: 400 }
    );
  }

  if (provider && !VALID_PROVIDERS.has(provider)) {
    return NextResponse.json(
      { error: "unsupported provider" },
      { status: 400 }
    );
  }

  const body = await request.json();
  const { message, sessionId } = body as {
    message?: ChatMessage;
    sessionId?: string;
  };

  const historyPath = getChatHistoryPath(ticketId, repoPath, provider);
  const legacyHistoryPath = getLegacyHistoryPath(ticketId, repoPath, provider);
  const worktreeDir = resolveWorktreeDir(ticketId, repoPath);

  const preflightResult = checkLegacyProcessAndMigrate(worktreeDir);
  if (preflightResult === "live-process-blocking") {
    return NextResponse.json(
      {
        error:
          "A job started before the .closedloop-ai migration is still running. Stop it first, then retry.",
      },
      { status: 409 }
    );
  }

  // Migrate legacy chat history AFTER preflight so the new dir creation
  // doesn't bypass the live-legacy-process guard above
  const historyDir = join(historyPath, "..");
  if (!existsSync(historyPath) && existsSync(legacyHistoryPath)) {
    if (!existsSync(historyDir)) {
      mkdirSync(historyDir, { recursive: true });
    }
    copyFileSync(legacyHistoryPath, historyPath);
    try {
      unlinkSync(legacyHistoryPath);
    } catch {
      /* best effort */
    }
  }
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
  const provider = searchParams.get("provider");

  if (!repoPath) {
    return NextResponse.json(
      { error: "repo parameter is required" },
      { status: 400 }
    );
  }

  if (provider && !VALID_PROVIDERS.has(provider)) {
    return NextResponse.json(
      { error: "unsupported provider" },
      { status: 400 }
    );
  }

  const historyPath = findChatHistoryPath(ticketId, repoPath, provider);
  const legacyPath = getLegacyHistoryPath(ticketId, repoPath, provider);
  const canonicalPath = getChatHistoryPath(ticketId, repoPath, provider);
  const worktreeDir = resolveWorktreeDir(ticketId, repoPath);
  const workDirs = [
    join(worktreeDir, ".closedloop-ai", "work"),
    join(worktreeDir, ".claude", "work"),
  ];

  if (!existsSync(historyPath)) {
    if (indexParam === null && !provider) {
      for (const wd of workDirs) {
        deleteSharedCodexChatState(wd);
      }
    }
    if (indexParam === null && provider === "codex") {
      for (const wd of workDirs) {
        const codexReviewPath = getCodexChatStatePath(wd, "review");
        try {
          unlinkSync(codexReviewPath);
        } catch {
          /* best-effort */
        }
      }
    }
    return NextResponse.json({
      success: true,
      message: "No history to delete",
    });
  }

  try {
    if (indexParam === null) {
      // Clear entire chat - delete from both roots to prevent resurrection
      for (const p of [canonicalPath, legacyPath]) {
        try {
          unlinkSync(p);
        } catch {
          /* best effort */
        }
      }

      if (provider === "codex") {
        for (const wd of workDirs) {
          try {
            unlinkSync(getCodexChatStatePath(wd, "review"));
          } catch {
            /* best-effort */
          }
        }
      } else if (!provider) {
        for (const wd of workDirs) {
          deleteSharedCodexChatState(wd);
        }
      }
      // provider=claude: do NOT touch any codex state files

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
