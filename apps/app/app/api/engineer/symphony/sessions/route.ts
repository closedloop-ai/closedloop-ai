import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { migrateLegacySessions } from "@/lib/engineer/migrate-sessions";
import {
  deleteSession,
  type PersistedSession,
  pruneInvalidSessions,
  upsertSession,
} from "@/lib/engineer/sessions";

/**
 * GET /api/symphony/sessions
 * Returns all active sessions
 */
export function GET() {
  migrateLegacySessions();

  // Filter out sessions where worktree no longer exists (lock-protected)
  const validSessions = pruneInvalidSessions((session) => {
    const worktreePath = session.worktreePath.startsWith("~/")
      ? join(homedir(), session.worktreePath.slice(2))
      : session.worktreePath;
    return existsSync(worktreePath);
  });

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
    loopId,
    artifactId,
  } = body as Partial<PersistedSession>;

  if (!(ticketId && repoPath && worktreePath)) {
    return NextResponse.json(
      { error: "ticketId, repoPath, and worktreePath are required" },
      { status: 400 }
    );
  }

  upsertSession({
    ticketId,
    repoPath,
    worktreePath,
    pid,
    contextRepoPaths,
    baseBranch,
    parentTicketId,
    loopId,
    artifactId,
  });

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

  deleteSession(ticketId);

  return NextResponse.json({ success: true });
}
