import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { glob } from "glob";
import { type NextRequest, NextResponse } from "next/server";
import {
  expandHome,
  getWorktreeParentDir,
  isRepoAllowed,
} from "@/lib/engineer/repos";

// Directories to exclude from search
const EXCLUDE_PATTERNS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.next/**",
  "**/dist/**",
  "**/build/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/venv/**",
  "**/*.pyc",
  "**/.DS_Store",
  "**/coverage/**",
  "**/.turbo/**",
];

/**
 * Construct worktree path from repo and ticket
 */
function getWorktreePath(repoPath: string, ticketId: string): string {
  const expandedRepoPath = expandHome(repoPath);
  const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const repoName = basename(expandedRepoPath);
  const worktreeParentDir = getWorktreeParentDir();
  return join(worktreeParentDir, `${repoName}-${sanitizedTicket}`);
}

/**
 * API route to search for files in a worktree or base repo
 *
 * GET /api/files/search?repo=~/Source/claude_code&ticket=AI-123&query=component
 * GET /api/files/search?repo=~/Source/claude_code&base=true&query=component
 *
 * Returns: { files: string[], truncated: boolean }
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const repoPath = searchParams.get("repo");
    const ticketId = searchParams.get("ticket");
    const query = searchParams.get("query") || "";
    const useBase = searchParams.get("base") === "true";

    // Validate inputs
    if (!repoPath) {
      return NextResponse.json(
        { error: "repo query parameter is required" },
        { status: 400 }
      );
    }

    if (!(useBase || ticketId)) {
      return NextResponse.json(
        { error: "ticket query parameter is required" },
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

    // Determine search directory: base repo or worktree
    let searchDir: string;
    if (useBase) {
      searchDir = expandHome(repoPath);
    } else {
      searchDir = getWorktreePath(repoPath, ticketId!);
    }

    // Check if directory exists
    if (!existsSync(searchDir)) {
      return NextResponse.json({
        files: [],
        truncated: false,
        error: useBase ? "Repository not found" : "Worktree not found",
      });
    }

    // Build glob pattern
    // If query is empty, match all files; otherwise match files containing the query
    const pattern = query ? `**/*${query}*` : "**/*";

    // Search for files
    const files = await glob(pattern, {
      cwd: searchDir,
      nodir: true,
      ignore: EXCLUDE_PATTERNS,
      dot: true, // Include dotfiles like .github/
      nocase: true, // Case-insensitive matching
      maxDepth: 10, // Limit depth to avoid extremely deep searches
    });

    // Sort by relevance:
    // 1. Exact filename match first
    // 2. Then by path length (shorter = more relevant)
    // 3. Then alphabetically
    const sortedFiles = [...files].sort((a: string, b: string) => {
      const aName = basename(a).toLowerCase();
      const bName = basename(b).toLowerCase();
      const queryLower = query.toLowerCase();

      // Exact filename match gets priority
      const aExact =
        aName === queryLower ||
        aName === `${queryLower}.ts` ||
        aName === `${queryLower}.tsx`;
      const bExact =
        bName === queryLower ||
        bName === `${queryLower}.ts` ||
        bName === `${queryLower}.tsx`;
      if (aExact && !bExact) {
        return -1;
      }
      if (bExact && !aExact) {
        return 1;
      }

      // Filename starts with query gets second priority
      const aStarts = aName.startsWith(queryLower);
      const bStarts = bName.startsWith(queryLower);
      if (aStarts && !bStarts) {
        return -1;
      }
      if (bStarts && !aStarts) {
        return 1;
      }

      // Shorter paths are more relevant
      if (a.length !== b.length) {
        return a.length - b.length;
      }

      // Alphabetical as tiebreaker
      return a.localeCompare(b);
    });

    // Limit results
    const maxResults = 10;
    const truncated = sortedFiles.length > maxResults;
    const limitedFiles = sortedFiles.slice(0, maxResults);

    return NextResponse.json({
      files: limitedFiles,
      truncated,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    console.error("[File Search API] Error:", errorMessage);
    return NextResponse.json(
      { error: `Failed to search files: ${errorMessage}` },
      { status: 500 }
    );
  }
}
