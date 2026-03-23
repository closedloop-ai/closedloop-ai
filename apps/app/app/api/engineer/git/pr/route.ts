import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type NextRequest, NextResponse } from "next/server";
import { getShellPathSync } from "@/lib/engineer/shell-path";

const execFileAsync = promisify(execFile);

const PR_NUMBER_REGEX = /\/pull\/(\d+)/;

/**
 * API route to create Pull Requests using gh CLI
 *
 * POST /api/engineer/git/pr
 * Body: { repoPath: string, title: string, body: string, ticketUrl?: string }
 */

export type PRCreateRequest = {
  repoPath: string;
  title: string;
  body: string;
  ticketUrl?: string;
};

export type PRCreateResponse = {
  success: boolean;
  url: string;
  number: number;
  message: string;
};

/**
 * Expand ~ to home directory in paths
 */
function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return path.replace("~", process.env.HOME || "");
  }
  return path;
}

/**
 * Parse gh CLI errors into user-friendly messages
 */
function parseGhError(err: unknown): string {
  const errorStr = String(err);

  // Common error patterns and friendly messages
  if (
    errorStr.includes("not logged in") ||
    errorStr.includes("authentication")
  ) {
    return "GitHub CLI not authenticated. Run 'gh auth login' in terminal.";
  }
  if (errorStr.includes("already exists")) {
    return "A pull request already exists for this branch.";
  }
  if (
    errorStr.includes("No commits between") ||
    errorStr.includes("no commits")
  ) {
    return "No commits to create a PR. Make sure changes are committed first.";
  }
  if (errorStr.includes("uncommitted changes")) {
    return "You have uncommitted changes. Commit them first.";
  }
  if (errorStr.includes("not a git repository")) {
    return "Not a git repository.";
  }
  if (errorStr.includes("permission denied") || errorStr.includes("403")) {
    return "Permission denied. Check your GitHub access.";
  }
  if (errorStr.includes("not found") || errorStr.includes("404")) {
    return "Repository not found or no access.";
  }
  if (errorStr.includes("network") || errorStr.includes("ENOTFOUND")) {
    return "Network error. Check your connection.";
  }

  // Default: return a generic message (log full error server-side)
  console.error("[PR API] Full error:", errorStr);
  return "Failed to create pull request. Check the logs for details.";
}

/**
 * Create an error response with consistent formatting
 */
function errorResponse(
  message: string,
  err?: unknown,
  status = 500
): NextResponse {
  const userMessage = err ? parseGhError(err) : message;
  return NextResponse.json({ error: userMessage }, { status });
}

export async function POST(request: NextRequest) {
  try {
    const body: PRCreateRequest = await request.json();
    const { repoPath, title, body: prBody, ticketUrl } = body;

    if (!repoPath) {
      return errorResponse("repoPath is required", undefined, 400);
    }

    if (!title) {
      return errorResponse("title is required", undefined, 400);
    }

    const expandedPath = expandPath(repoPath);

    // Build the PR body with ticket link if provided
    let fullBody = prBody || "";
    if (ticketUrl) {
      fullBody = `${fullBody}\n\n---\nLinear: ${ticketUrl}`.trim();
    }

    try {
      // Get current branch name
      const { stdout: branchOutput } = await execFileAsync(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        {
          cwd: expandedPath,
          env: {
            ...process.env,
            PATH: getShellPathSync(),
          },
        }
      );
      const currentBranch = branchOutput.trim();
      console.log("[PR API] Current branch:", currentBranch);

      // Ensure branch is pushed to remote
      await execFileAsync("git", ["push", "-u", "origin", currentBranch], {
        cwd: expandedPath,
        env: {
          ...process.env,
          PATH: getShellPathSync(),
        },
      });

      // Create PR using gh CLI with explicit --head flag
      const ghArgs = [
        "pr",
        "create",
        "--head",
        currentBranch,
        "--title",
        title,
        "--body",
        fullBody,
      ];

      // Create the PR (output is the PR URL)
      const { stdout: createOutput } = await execFileAsync("gh", ghArgs, {
        cwd: expandedPath,
        env: {
          ...process.env,
          PATH: getShellPathSync(),
        },
      });

      // The output is the PR URL, extract PR number from it
      const prUrl = createOutput.trim();
      const prNumberMatch = PR_NUMBER_REGEX.exec(prUrl);

      if (prNumberMatch) {
        return NextResponse.json({
          success: true,
          url: prUrl,
          number: Number.parseInt(prNumberMatch[1], 10),
          message: `Created PR #${prNumberMatch[1]}`,
        } satisfies PRCreateResponse);
      }

      // Fallback: get PR info using gh pr view
      const { stdout: viewOutput } = await execFileAsync(
        "gh",
        ["pr", "view", "--json", "url,number"],
        {
          cwd: expandedPath,
          env: {
            ...process.env,
            PATH: getShellPathSync(),
          },
        }
      );
      const result = JSON.parse(viewOutput);

      return NextResponse.json({
        success: true,
        url: result.url,
        number: result.number,
        message: `Created PR #${result.number}`,
      } satisfies PRCreateResponse);
    } catch (err) {
      // Check if it's because a PR already exists
      const errorStr = String(err);
      if (errorStr.includes("already exists")) {
        // Try to get the existing PR URL
        try {
          const { stdout: existingPr } = await execFileAsync(
            "gh",
            ["pr", "view", "--json", "url,number"],
            {
              cwd: expandedPath,
              env: {
                ...process.env,
                PATH: getShellPathSync(),
              },
            }
          );
          const existing = JSON.parse(existingPr);
          return NextResponse.json({
            success: true,
            url: existing.url,
            number: existing.number,
            message: `PR #${existing.number} already exists`,
          } satisfies PRCreateResponse);
        } catch {
          return errorResponse(
            "PR already exists but could not retrieve URL",
            err
          );
        }
      }

      return errorResponse("Failed to create PR", err);
    }
  } catch (err) {
    return errorResponse("PR operation failed", err);
  }
}
