import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join, sep } from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { expandHome, getWorktreeParentDir } from "@/lib/engineer/repos";

/**
 * API route to serve Symphony attachment images
 *
 * GET /api/symphony/attachments/[ticketId]/[...path]?repo=~/Source/repo-name
 *
 * Serves images from the .closedloop-ai/work/attachments directory
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string; path: string[] }> }
) {
  const { ticketId, path: pathSegments } = await params;
  const searchParams = request.nextUrl.searchParams;
  const repoPath = searchParams.get("repo");

  if (!repoPath) {
    return NextResponse.json(
      { error: "repo parameter is required" },
      { status: 400 }
    );
  }

  // Expand ~ to home directory
  const expandedRepoPath = expandHome(repoPath);

  // Sanitize ticket ID
  const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const repoName = basename(expandedRepoPath);
  const worktreeParentDir = getWorktreeParentDir();
  const worktreeDir = join(worktreeParentDir, `${repoName}-${sanitizedTicket}`);

  // Build the file path from segments
  const filename = pathSegments.join("/");
  const attachmentsDir = join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    "attachments"
  );
  const filePath = join(attachmentsDir, filename);

  // Security check: ensure the path stays within the attachments directory.
  if (!filePath.startsWith(attachmentsDir + sep)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 403 });
  }

  if (!existsSync(filePath)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  try {
    const fileBuffer = readFileSync(filePath);

    // Determine content type from extension
    const ext = extname(filePath).toLowerCase();
    const contentTypes: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
    };

    const contentType = contentTypes[ext] || "application/octet-stream";

    return new NextResponse(fileBuffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
