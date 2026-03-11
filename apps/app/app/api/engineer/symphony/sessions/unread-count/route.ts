import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { migrateLegacySessions } from "@/lib/engineer/migrate-sessions";

type ActiveSession = {
  ticketId: string;
  repoPath: string;
  worktreePath: string;
};

type ChatHistory = {
  messages: { role: "user" | "assistant" }[];
};

const SESSIONS_FILE = join(homedir(), ".closedloop-ai", "sessions.json");

/**
 * GET /api/engineer/symphony/sessions/unread-count
 *
 * Returns the number of active sessions whose last chat message
 * is from the assistant (i.e. an unanswered reply).
 */
export function GET() {
  migrateLegacySessions();

  if (!existsSync(SESSIONS_FILE)) {
    return NextResponse.json({ count: 0 });
  }

  let sessions: ActiveSession[];
  try {
    const content = readFileSync(SESSIONS_FILE, "utf-8");
    sessions = (JSON.parse(content) as { sessions: ActiveSession[] }).sessions;
  } catch {
    return NextResponse.json({ count: 0 });
  }

  let count = 0;
  for (const session of sessions) {
    const worktreePath = session.worktreePath.startsWith("~/")
      ? join(homedir(), session.worktreePath.slice(2))
      : session.worktreePath;

    if (!existsSync(worktreePath)) {
      continue;
    }

    const chatPath = join(worktreePath, ".claude", "work", "chat-history.json");
    if (!existsSync(chatPath)) {
      continue;
    }

    try {
      const raw = readFileSync(chatPath, "utf-8");
      const history = JSON.parse(raw) as ChatHistory;
      const messages = history.messages;
      if (messages.at(-1)?.role === "assistant") {
        count++;
      }
    } catch {
      // Corrupt or unreadable chat history — skip
    }
  }

  return NextResponse.json({ count });
}
