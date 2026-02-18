import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import type { EvaluationReport } from "@/lib/engineer/queries/symphony";
import {
  expandHome,
  getWorktreeParentDir,
  isRepoAllowed,
} from "@/lib/engineer/repos";

/**
 * API route to read judges.json from a Symphony worktree
 *
 * GET /api/symphony/judges/[ticketId]?repo=~/Source/claude_code
 *
 * Returns the evaluation report with isMock flag to indicate data source
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  try {
    const { ticketId } = await params;
    const { searchParams } = new URL(request.url);
    const repoPath = searchParams.get("repo");

    // Validate inputs
    if (!ticketId) {
      return NextResponse.json(
        { error: "ticketId is required" },
        { status: 400 }
      );
    }

    if (!repoPath) {
      return NextResponse.json(
        { error: "repo query parameter is required" },
        { status: 400 }
      );
    }

    // Security check
    if (!isRepoAllowed(repoPath)) {
      return NextResponse.json(
        { error: `Repository not allowed: ${repoPath}` },
        { status: 403 }
      );
    }

    // Sanitize ticket identifier
    const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");

    // Build worktree path
    const expandedRepoPath = expandHome(repoPath);
    const repoName = basename(expandedRepoPath);
    const worktreeParentDir = getWorktreeParentDir();
    const worktreeDir = join(
      worktreeParentDir,
      `${repoName}-${sanitizedTicket}`
    );
    const judgesPath = join(worktreeDir, ".claude", "work", "judges.json");

    // Check if worktree exists
    if (!existsSync(worktreeDir)) {
      return NextResponse.json(
        { error: "Worktree not found", exists: false, isMock: false },
        { status: 404 }
      );
    }

    // Try to read judges.json from worktree
    if (existsSync(judgesPath)) {
      try {
        const judgesContent = await readFile(judgesPath, "utf-8");
        let data: EvaluationReport;

        try {
          // First, try parsing as standard JSON
          data = JSON.parse(judgesContent) as EvaluationReport;
        } catch {
          // Fallback: Strip trailing commas before ] or } — Claude edits can introduce them
          // LIMITATION: This regex approach may corrupt JSON string content containing
          // array/object literals (e.g., "example: [1,]"). For a robust solution,
          // install and use a JSON5 parser (npm install json5).
          const fixedContent = judgesContent.replaceAll(/,\s*([\]}])/g, "$1");
          data = JSON.parse(fixedContent) as EvaluationReport;
        }

        return NextResponse.json({
          exists: true,
          isMock: false,
          data,
          worktreeDir,
        });
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Unknown error";
        return NextResponse.json(
          {
            error: `Judges feedback is corrupted: ${errorMessage}`,
            exists: true,
            isMock: false,
          },
          { status: 500 }
        );
      }
    }

    // File doesn't exist - return awaiting status
    return NextResponse.json({
      exists: false,
      isMock: false,
      message: "Awaiting LLM judges feedback",
      worktreeDir,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to read judges data: ${errorMessage}` },
      { status: 500 }
    );
  }
}
