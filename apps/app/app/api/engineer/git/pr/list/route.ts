import { exec } from "node:child_process";
import { promisify } from "node:util";
import { type NextRequest, NextResponse } from "next/server";

const execAsync = promisify(exec);

function expandPath(repoPath: string): string {
  return repoPath.startsWith("~/")
    ? repoPath.replace("~", process.env.HOME || "")
    : repoPath;
}

export type PRListItem = {
  number: number;
  title: string;
  url: string;
  author: string;
  state: string;
  createdAt: string;
  headRefName: string;
};

/**
 * GET /api/git/pr/list?repo=<path>&state=<open|merged>
 *
 * Lists PRs for a repo via `gh pr list`.
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const repoPath = searchParams.get("repo");
  const state = searchParams.get("state") || "open";

  if (!repoPath) {
    return NextResponse.json(
      { error: "Missing 'repo' query parameter" },
      { status: 400 }
    );
  }

  if (state !== "open" && state !== "merged") {
    return NextResponse.json(
      { error: "state must be 'open' or 'merged'" },
      { status: 400 }
    );
  }

  const cwd = expandPath(repoPath);

  try {
    const { stdout } = await execAsync(
      `gh pr list --state ${state} --limit 50 --json number,title,url,author,state,createdAt,headRefName`,
      { cwd }
    );

    const raw = JSON.parse(stdout) as Array<{
      number: number;
      title: string;
      url: string;
      author: { login: string };
      state: string;
      createdAt: string;
      headRefName: string;
    }>;

    const prs: PRListItem[] = raw.map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author?.login || "unknown",
      state: pr.state,
      createdAt: pr.createdAt,
      headRefName: pr.headRefName,
    }));

    return NextResponse.json({ prs });
  } catch (error) {
    console.error("Error listing PRs:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
