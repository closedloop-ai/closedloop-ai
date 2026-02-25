import { exec } from "node:child_process";
import { promisify } from "node:util";
import { type NextRequest, NextResponse } from "next/server";

const execAsync = promisify(exec);

export const dynamic = "force-dynamic";

const GITHUB_REMOTE_REGEX = /github\.com[:/]([^/]+\/[^/\s]+?)(?:\.git)?$/;
const GIT_SUFFIX_REGEX = /\.git$/;

function expandPath(repoPath: string): string {
  return repoPath.startsWith("~/")
    ? repoPath.replace("~", process.env.HOME || "")
    : repoPath;
}

async function getRepoSlug(cwd: string): Promise<string> {
  try {
    const { stdout: remoteUrl } = await execAsync("git remote get-url origin", {
      cwd,
    });
    const match = GITHUB_REMOTE_REGEX.exec(remoteUrl.trim());
    return match ? match[1].replace(GIT_SUFFIX_REGEX, "") : "";
  } catch {
    return "";
  }
}

/**
 * GET /api/git/pr/head-sha?repo=...&pr=123
 *
 * Returns the head commit SHA of a PR for use with inline comments.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const repoPath = searchParams.get("repo");
  const prNumber = searchParams.get("pr");

  if (!(repoPath && prNumber)) {
    return NextResponse.json(
      { error: "repo and pr are required" },
      { status: 400 }
    );
  }

  const cwd = expandPath(repoPath);

  try {
    const repoSlug = await getRepoSlug(cwd);
    if (!repoSlug) {
      return NextResponse.json(
        { error: "Could not determine repository" },
        { status: 500 }
      );
    }

    const { stdout } = await execAsync(
      `gh api repos/${repoSlug}/pulls/${prNumber} --jq '.head.sha'`,
      { cwd }
    );

    const sha = stdout.trim();
    if (!sha) {
      return NextResponse.json(
        { error: "Could not get head SHA" },
        { status: 500 }
      );
    }

    return NextResponse.json({ sha });
  } catch (error) {
    console.error("[head-sha] Error:", error);
    return NextResponse.json(
      { error: "Failed to get PR head SHA" },
      { status: 500 }
    );
  }
}
