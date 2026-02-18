import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { type NextRequest, NextResponse } from "next/server";

const execAsync = promisify(exec);

const GITHUB_REMOTE_REGEX = /github\.com[:/]([^/]+\/[^/\s]+?)(?:\.git)?$/;
const GIT_SUFFIX_REGEX = /\.git$/;

type InlineCommentRequest = {
  repoPath: string;
  prNumber: number;
  body: string;
  path?: string;
  line?: number;
  commitSha?: string;
};

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

function ghApiViaStdin(
  apiPath: string,
  payload: Record<string, unknown>,
  cwd: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "gh",
      ["api", apiPath, "--method", "POST", "--input", "-"],
      { cwd }
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err = new Error(`gh api exited with code ${code}: ${stderr}`);
        Object.assign(err, { stdout, stderr });
        reject(err);
      }
    });
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

function ghPrCommentViaStdin(
  args: string[],
  body: string,
  cwd: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("gh", [...args, "--body-file", "-"], { cwd });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err = new Error(
          `gh pr comment exited with code ${code}: ${stderr}`
        );
        Object.assign(err, { stdout, stderr });
        reject(err);
      }
    });
    proc.stdin.write(body);
    proc.stdin.end();
  });
}

/**
 * POST /api/git/pr/inline-comment
 *
 * Submit a new PR comment — inline (file-specific) or general.
 * - Inline: requires path, line, commitSha → uses GitHub REST API for pull request comments
 * - General: no path/line → uses `gh pr comment`
 */
export async function POST(request: NextRequest) {
  let reqBody: InlineCommentRequest;
  try {
    reqBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { repoPath, prNumber, body, path, line, commitSha } = reqBody;

  if (!repoPath) {
    return NextResponse.json(
      { error: "repoPath is required" },
      { status: 400 }
    );
  }
  if (!prNumber) {
    return NextResponse.json(
      { error: "prNumber is required" },
      { status: 400 }
    );
  }
  if (!body) {
    return NextResponse.json({ error: "body is required" }, { status: 400 });
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

    // Inline comment (line-specific), falls back to file-level if line not in diff
    if (path && line && commitSha) {
      const apiPath = `repos/${repoSlug}/pulls/${prNumber}/comments`;
      try {
        const result = await ghApiViaStdin(
          apiPath,
          { body, path, line, commit_id: commitSha, side: "RIGHT" },
          cwd
        );
        return NextResponse.json({
          success: true,
          output: result.stdout.trim(),
        });
      } catch {
        // Line not in diff — fall through to file-level comment
      }
    }

    // File-level comment (no line number), falls back to general if path not in diff
    if (path && commitSha) {
      const apiPath = `repos/${repoSlug}/pulls/${prNumber}/comments`;
      try {
        const result = await ghApiViaStdin(
          apiPath,
          { body, path, commit_id: commitSha, subject_type: "file" },
          cwd
        );
        return NextResponse.json({
          success: true,
          output: result.stdout.trim(),
        });
      } catch {
        // Path not in diff — fall through to general comment
      }
    }

    // General comment
    const args = ["pr", "comment", String(prNumber), "-R", repoSlug];
    const result = await ghPrCommentViaStdin(args, body, cwd);
    return NextResponse.json({ success: true, output: result.stdout.trim() });
  } catch (error) {
    console.error("[inline-comment] Error:", error);
    const execError = error as { stderr?: string; message?: string };
    return NextResponse.json(
      {
        error:
          execError.stderr || execError.message || "Failed to post comment",
      },
      { status: 500 }
    );
  }
}
