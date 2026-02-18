import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { type NextRequest, NextResponse } from "next/server";

const execAsync = promisify(exec);

const GITHUB_REMOTE_REGEX = /github\.com[:/]([^/]+\/[^/\s]+?)(?:\.git)?$/;
const GIT_SUFFIX_REGEX = /\.git$/;

type ReplyRequest = {
  repoPath: string;
  commentId?: number; // databaseId for threaded reply (optional - if 0 or missing, adds new comment)
  body: string;
  prNumber?: number; // PR number
};

/**
 * Run gh command with body passed via stdin to avoid shell escaping issues
 */
function ghApiViaStdin(
  apiPath: string,
  body: string,
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
    proc.stdin.write(JSON.stringify({ body }));
    proc.stdin.end();
  });
}

/**
 * Run gh pr comment with body passed via stdin
 */
function ghPrCommentViaStdin(
  args: string[],
  body: string,
  cwd: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Use --body-file - to read from stdin
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
    console.log("[PR Reply API] Could not determine repo from remote");
    return "";
  }
}

async function postReply(
  reqBody: ReplyRequest,
  cwd: string,
  repoSlug: string
): Promise<NextResponse> {
  const { commentId, prNumber, body: replyBody } = reqBody;

  if (!prNumber) {
    return NextResponse.json(
      { error: "prNumber is required" },
      { status: 400 }
    );
  }

  if (commentId && commentId > 0 && repoSlug) {
    const apiPath = `repos/${repoSlug}/pulls/${prNumber}/comments/${commentId}/replies`;
    const result = await ghApiViaStdin(apiPath, replyBody, cwd);
    return NextResponse.json({
      success: true,
      message: "Reply posted successfully",
      output: result.stdout.trim(),
    });
  }

  const args = ["pr", "comment", String(prNumber)];
  if (repoSlug) {
    args.push("-R", repoSlug);
  }
  const result = await ghPrCommentViaStdin(args, replyBody, cwd);
  return NextResponse.json({
    success: true,
    message: "Comment posted successfully",
    output: result.stdout.trim(),
  });
}

const ERROR_MAP: Array<{ match: string; error: string; status: number }> = [
  {
    match: "gh: command not found",
    error: "GitHub CLI (gh) is not installed",
    status: 500,
  },
  {
    match: "not logged in",
    error: "GitHub CLI is not authenticated. Run 'gh auth login'",
    status: 401,
  },
  {
    match: "Could not resolve",
    error: "Comment not found or PR does not exist",
    status: 404,
  },
];

function handleGhError(error: unknown): NextResponse {
  console.error("[PR Reply API] Error:", error);
  const execError = error as {
    stdout?: string;
    stderr?: string;
    message?: string;
  };
  if (execError.stdout) {
    console.error("[PR Reply API] Error stdout:", execError.stdout);
  }
  if (execError.stderr) {
    console.error("[PR Reply API] Error stderr:", execError.stderr);
  }

  const errorMessage = execError.stderr || execError.message || "Unknown error";
  const mapped = ERROR_MAP.find((e) => errorMessage.includes(e.match));
  return NextResponse.json(
    { error: mapped?.error ?? errorMessage },
    { status: mapped?.status ?? 500 }
  );
}

/**
 * POST /api/git/pr/reply
 * Replies to a specific PR review comment thread or adds a new comment to the PR
 *
 * Uses stdin to pass the body content to avoid shell escaping/truncation issues
 * with backticks, quotes, and other special characters in markdown.
 */
export async function POST(request: NextRequest) {
  let reqBody: ReplyRequest;

  try {
    reqBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { repoPath, body: replyBody } = reqBody;

  if (!repoPath) {
    return NextResponse.json(
      { error: "Missing 'repoPath' in request body" },
      { status: 400 }
    );
  }
  if (!replyBody) {
    return NextResponse.json(
      { error: "Missing 'body' in request body" },
      { status: 400 }
    );
  }

  const cwd = expandPath(repoPath);

  try {
    const repoSlug = await getRepoSlug(cwd);
    return await postReply(reqBody, cwd, repoSlug);
  } catch (error) {
    return handleGhError(error);
  }
}
