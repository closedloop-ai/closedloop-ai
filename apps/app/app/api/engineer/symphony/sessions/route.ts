import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { migrateLegacySessions } from "@/lib/engineer/migrate-sessions";

type ActiveSession = {
  ticketId: string;
  repoPath: string;
  worktreePath: string;
  pid?: number;
  contextRepoPaths?: string[];
  /** The branch this worktree was created from (e.g., "main" or "feature/AI-100") */
  baseBranch?: string;
  /** If stacked on another ticket's branch, the parent ticket ID (e.g., "AI-100") */
  parentTicketId?: string;
  startedAt: string;
  lastAccessedAt: string;
};

type SessionsConfig = {
  sessions: ActiveSession[];
};

const CLOSEDLOOP_DIR = join(homedir(), ".closedloop-ai");
const SESSIONS_FILE = join(CLOSEDLOOP_DIR, "sessions.json");

/**
 * Ensure ~/.closedloop-ai directory exists
 */
function ensureDir() {
  if (!existsSync(CLOSEDLOOP_DIR)) {
    mkdirSync(CLOSEDLOOP_DIR, { recursive: true });
  }
}

/**
 * Load sessions from config file
 */
function loadSessions(): SessionsConfig {
  ensureDir();
  migrateLegacySessions();
  if (!existsSync(SESSIONS_FILE)) {
    return { sessions: [] };
  }
  try {
    const content = readFileSync(SESSIONS_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { sessions: [] };
  }
}

/**
 * Save sessions to config file
 */
function saveSessions(config: SessionsConfig) {
  ensureDir();
  writeFileSync(SESSIONS_FILE, JSON.stringify(config, null, 2));
}

/**
 * GET /api/symphony/sessions
 * Returns all active sessions
 */
export function GET() {
  const config = loadSessions();

  // Filter out sessions where worktree no longer exists
  const validSessions = config.sessions.filter((session) => {
    const worktreePath = session.worktreePath.startsWith("~/")
      ? join(homedir(), session.worktreePath.slice(2))
      : session.worktreePath;
    return existsSync(worktreePath);
  });

  // Update config if we filtered out any invalid sessions
  if (validSessions.length !== config.sessions.length) {
    saveSessions({ sessions: validSessions });
  }

  return NextResponse.json({ sessions: validSessions });
}

/**
 * POST /api/engineer/symphony/sessions
 * Add or update a session
 * Body: { ticketId, repoPath, worktreePath }
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const {
    ticketId,
    repoPath,
    worktreePath,
    pid,
    contextRepoPaths,
    baseBranch,
    parentTicketId,
  } = body;

  if (!(ticketId && repoPath && worktreePath)) {
    return NextResponse.json(
      { error: "ticketId, repoPath, and worktreePath are required" },
      { status: 400 }
    );
  }

  const config = loadSessions();
  const now = new Date().toISOString();

  // Find existing session for this ticket
  const existingIndex = config.sessions.findIndex(
    (s) => s.ticketId === ticketId
  );

  if (existingIndex >= 0) {
    // Update existing session
    config.sessions[existingIndex] = {
      ...config.sessions[existingIndex],
      repoPath,
      worktreePath,
      ...(pid !== undefined && { pid }),
      ...(contextRepoPaths !== undefined && { contextRepoPaths }),
      ...(baseBranch !== undefined && { baseBranch }),
      ...(parentTicketId !== undefined && { parentTicketId }),
      lastAccessedAt: now,
    };
  } else {
    // Add new session
    config.sessions.push({
      ticketId,
      repoPath,
      worktreePath,
      ...(pid !== undefined && { pid }),
      ...(contextRepoPaths !== undefined && { contextRepoPaths }),
      ...(baseBranch !== undefined && { baseBranch }),
      ...(parentTicketId !== undefined && { parentTicketId }),
      startedAt: now,
      lastAccessedAt: now,
    });
  }

  saveSessions(config);

  return NextResponse.json({ success: true });
}

/**
 * DELETE /api/symphony/sessions?ticketId=...
 * Remove a session
 */
export function DELETE(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const ticketId = searchParams.get("ticketId");

  if (!ticketId) {
    return NextResponse.json(
      { error: "ticketId parameter is required" },
      { status: 400 }
    );
  }

  const config = loadSessions();
  config.sessions = config.sessions.filter((s) => s.ticketId !== ticketId);
  saveSessions(config);

  return NextResponse.json({ success: true });
}
