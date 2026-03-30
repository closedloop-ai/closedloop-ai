import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import {
  expandHome,
  getWorktreeParentDir,
  isRepoAllowed,
} from "@/lib/engineer/repos";

export const dynamic = "force-dynamic";

type PersistedFinding = {
  severity: string;
  priority?: string;
  file?: string;
  line?: number;
  message: string;
  suggestion?: string;
  commented: boolean;
};

type FindingsFile = {
  provider: string;
  model: string;
  findings: PersistedFinding[];
  declined?: boolean;
  declineReason?: string;
};

function getWorktreeDir(ticketId: string, repoPath: string): string {
  const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const expandedRepoPath = expandHome(repoPath);
  const repoName = basename(expandedRepoPath);
  const worktreeParentDir = getWorktreeParentDir();
  return join(worktreeParentDir, `${repoName}-${sanitizedTicket}`);
}

function getFindingsReadPath(
  ticketId: string,
  repoPath: string,
  provider: string
): string {
  const worktreeDir = getWorktreeDir(ticketId, repoPath);
  return join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    `review-findings-${provider}.json`
  );
}

function getFindingsWritePath(
  ticketId: string,
  repoPath: string,
  provider: string
): string {
  const worktreeDir = getWorktreeDir(ticketId, repoPath);
  return join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    `review-findings-${provider}.json`
  );
}

/**
 * GET /api/codex/review-findings/[ticketId]?repo=...
 *
 * Returns persisted review findings. Returns { findings: [] } if file doesn't exist.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  const { ticketId } = await params;
  const repoPath = request.nextUrl.searchParams.get("repo");
  const provider = request.nextUrl.searchParams.get("provider") ?? "codex";

  if (!(ticketId && repoPath)) {
    return NextResponse.json(
      { error: "ticketId and repo are required" },
      { status: 400 }
    );
  }

  if (!isRepoAllowed(repoPath)) {
    return NextResponse.json(
      { error: `Repository not allowed: ${repoPath}` },
      { status: 403 }
    );
  }

  const findingsPath = getFindingsReadPath(ticketId, repoPath, provider);

  if (!(findingsPath && existsSync(findingsPath))) {
    return NextResponse.json({ findings: [] });
  }

  try {
    const content = await readFile(findingsPath, "utf-8");
    const data: FindingsFile = JSON.parse(content);
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ findings: [] });
  }
}

/**
 * POST /api/engineer/codex/review-findings/[ticketId]?repo=...&provider=claude
 *
 * Three modes:
 * - Save findings: body = { provider, model, findings }
 * - Mark commented: body = { commentedIndex: number }
 * - Mark declined: body = { declined: true, declineReason: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  const { ticketId } = await params;
  const repoPath = request.nextUrl.searchParams.get("repo");
  const provider = request.nextUrl.searchParams.get("provider") ?? "codex";

  if (!(ticketId && repoPath)) {
    return NextResponse.json(
      { error: "ticketId and repo are required" },
      { status: 400 }
    );
  }

  if (!isRepoAllowed(repoPath)) {
    return NextResponse.json(
      { error: `Repository not allowed: ${repoPath}` },
      { status: 403 }
    );
  }

  const findingsReadPath = getFindingsReadPath(ticketId, repoPath, provider);
  const findingsWritePath = getFindingsWritePath(ticketId, repoPath, provider);
  const body = await request.json();

  if (typeof body.commentedIndex === "number") {
    return markFindingCommented(
      findingsReadPath,
      findingsWritePath,
      body.commentedIndex
    );
  }

  if (body.declined === true && typeof body.declineReason === "string") {
    return markDeclined(
      findingsReadPath,
      findingsWritePath,
      body.declineReason
    );
  }

  if (body.findings && Array.isArray(body.findings)) {
    return saveFindings(findingsWritePath, body);
  }

  return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
}

async function markFindingCommented(
  readPath: string | null,
  writePath: string,
  index: number
) {
  if (!(readPath && existsSync(readPath))) {
    return NextResponse.json(
      { error: "No findings file found" },
      { status: 404 }
    );
  }

  try {
    const content = await readFile(readPath, "utf-8");
    const data: FindingsFile = JSON.parse(content);

    if (index < 0 || index >= data.findings.length) {
      return NextResponse.json(
        { error: "Index out of range" },
        { status: 400 }
      );
    }

    data.findings[index].commented = true;
    const dir = join(writePath, "..");
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(writePath, JSON.stringify(data, null, 2));
    // Clean up stale legacy copy if we diverged read/write paths
    if (readPath !== writePath) {
      try {
        await unlink(readPath);
      } catch {
        /* best effort */
      }
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to update findings: ${msg}` },
      { status: 500 }
    );
  }
}

async function markDeclined(
  readPath: string | null,
  writePath: string,
  reason: string
) {
  if (!(readPath && existsSync(readPath))) {
    return NextResponse.json(
      { error: "No findings file found" },
      { status: 404 }
    );
  }

  try {
    const content = await readFile(readPath, "utf-8");
    const data: FindingsFile = JSON.parse(content);
    data.declined = true;
    data.declineReason = reason;
    const dir = join(writePath, "..");
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(writePath, JSON.stringify(data, null, 2));
    if (readPath !== writePath) {
      try {
        await unlink(readPath);
      } catch {
        /* best effort */
      }
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to mark declined: ${msg}` },
      { status: 500 }
    );
  }
}

async function saveFindings(
  findingsPath: string,
  body: Record<string, unknown>
) {
  try {
    const dir = join(findingsPath, "..");
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    const findings = body.findings as Record<string, unknown>[];
    const data: FindingsFile = {
      provider: (body.provider as string) || "unknown",
      model: (body.model as string) || "unknown",
      findings: findings.map(
        (f): PersistedFinding => ({
          severity: (f.severity as string) || "info",
          priority: f.priority as string | undefined,
          file: f.file as string | undefined,
          line: f.line as number | undefined,
          message: (f.message as string) || "",
          suggestion: f.suggestion as string | undefined,
          commented: f.commented as boolean,
        })
      ),
    };

    await writeFile(findingsPath, JSON.stringify(data, null, 2));
    return NextResponse.json({ success: true, count: data.findings.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to save findings: ${msg}` },
      { status: 500 }
    );
  }
}
