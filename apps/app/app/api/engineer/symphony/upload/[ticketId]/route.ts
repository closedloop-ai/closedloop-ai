import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { expandHome, getWorktreeParentDir } from "@/lib/engineer/repos";

const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const EXT_MAP: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/**
 * POST /api/symphony/upload/[ticketId]?repo=<repoPath>
 *
 * Accepts multipart/form-data with image files.
 * Saves to .claude/work/attachments/ and returns metadata.
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

  const expandedRepoPath = expandHome(repoPath);
  const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const repoName = basename(expandedRepoPath);
  const worktreeParentDir = getWorktreeParentDir();
  const worktreeDir = join(worktreeParentDir, `${repoName}-${sanitizedTicket}`);

  if (!existsSync(worktreeDir)) {
    return NextResponse.json(
      { error: "Work directory not found" },
      { status: 404 }
    );
  }

  const attachmentsDir = join(worktreeDir, ".claude", "work", "attachments");
  if (!existsSync(attachmentsDir)) {
    mkdirSync(attachmentsDir, { recursive: true });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const files: {
    originalName: string;
    savedName: string;
    path: string;
    apiUrl: string;
    size: number;
  }[] = [];

  const entries = formData.getAll("file");

  for (const entry of entries) {
    if (!(entry instanceof File)) {
      continue;
    }

    if (!ALLOWED_TYPES.has(entry.type)) {
      return NextResponse.json(
        {
          error: `File type not allowed: ${entry.type}. Allowed: png, jpeg, gif, webp`,
        },
        { status: 400 }
      );
    }

    if (entry.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        {
          error: `File too large: ${entry.name} (${(entry.size / 1024 / 1024).toFixed(1)}MB). Max 10MB.`,
        },
        { status: 400 }
      );
    }

    const ext = EXT_MAP[entry.type] || extname(entry.name) || ".png";
    const hex = Math.random().toString(16).slice(2, 6);
    const savedName = `chat-img-${Date.now()}-${hex}${ext}`;
    const savedPath = join(attachmentsDir, savedName);

    const buffer = Buffer.from(await entry.arrayBuffer());
    writeFileSync(savedPath, buffer);

    const apiUrl = `/api/engineer/symphony/attachments/${encodeURIComponent(ticketId)}/${encodeURIComponent(savedName)}?repo=${encodeURIComponent(repoPath)}`;

    files.push({
      originalName: entry.name,
      savedName,
      path: savedPath,
      apiUrl,
      size: entry.size,
    });
  }

  if (files.length === 0) {
    return NextResponse.json(
      { error: "No image files provided" },
      { status: 400 }
    );
  }

  return NextResponse.json({ files });
}
