import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { expandHome } from "@/lib/engineer/repos";
import type { DirectoryEntry } from "@/types/repos";

/**
 * API route to list directories for autocomplete
 *
 * GET /api/directories?path=~/Source
 *
 * Returns: { directories: DirectoryEntry[] }
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const pathParam = searchParams.get("path") || "~";

    // Expand ~ to home directory
    const expandedPath = expandHome(pathParam);

    // Check if path exists
    if (!existsSync(expandedPath)) {
      return NextResponse.json({ directories: [] });
    }

    // Read directory contents
    const entries = await readdir(expandedPath, { withFileTypes: true });

    // Filter to directories only, excluding hidden directories
    const directories: DirectoryEntry[] = [];

    for (const entry of entries) {
      // Skip hidden directories (starting with .)
      if (entry.name.startsWith(".")) {
        continue;
      }

      // Only include directories
      if (!entry.isDirectory()) {
        continue;
      }

      const fullPath = join(expandedPath, entry.name);

      // Check if it's a git repo
      const isGitRepo = existsSync(join(fullPath, ".git"));

      // Contract home directory back to ~ for display
      const displayPath = pathParam.startsWith("~")
        ? join(pathParam, entry.name)
        : fullPath;

      directories.push({
        name: entry.name,
        path: displayPath,
        isDirectory: true,
        isGitRepo,
      });
    }

    // Sort: git repos first, then alphabetically
    directories.sort((a, b) => {
      if (a.isGitRepo && !b.isGitRepo) {
        return -1;
      }
      if (!a.isGitRepo && b.isGitRepo) {
        return 1;
      }
      return a.name.localeCompare(b.name);
    });

    return NextResponse.json({ directories });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    console.error("[Directories API] Error:", errorMessage);
    return NextResponse.json(
      { error: `Failed to list directories: ${errorMessage}` },
      { status: 500 }
    );
  }
}
