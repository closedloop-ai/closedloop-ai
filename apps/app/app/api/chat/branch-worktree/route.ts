import { type NextRequest, NextResponse } from "next/server";
import { resolveBranchWorktree } from "@/lib/engineer/branch-worktree";

export const dynamic = "force-dynamic";

type BranchWorktreeResponse = {
  path: string | null;
  repoPath: string | null;
};

function parsePrNumber(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

export function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const repoFullName = searchParams.get("repoFullName");
  const headBranch = searchParams.get("headBranch");
  const prNumber = parsePrNumber(searchParams.get("prNumber"));

  if (!(repoFullName && headBranch && prNumber)) {
    return NextResponse.json(
      { error: "repoFullName, headBranch, and prNumber are required" },
      { status: 400 }
    );
  }

  try {
    const match = resolveBranchWorktree(repoFullName, headBranch, prNumber);
    const body: BranchWorktreeResponse = match
      ? { path: match.path, repoPath: match.repoPath }
      : { path: null, repoPath: null };
    return NextResponse.json(body);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to resolve branch worktree";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
