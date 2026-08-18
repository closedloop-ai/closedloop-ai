import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isNetworkError } from "../../main/logging/gateway-logger.js";
import { getShellEnv } from "../shell-path.js";
import { getResolvedGitPath } from "./symphony-loop.js";

/**
 * Shared process/plumbing helpers for the `git`/`gh`-backed PR gateway routes.
 *
 * Extracted from `git-pr.ts` (ISS-4664) so the PR-creation route and the PR
 * data/comment routes can share one implementation of "run a bounded git/gh
 * command" and one GitHub error classifier instead of each growing a copy.
 */

const execFileAsync = promisify(execFile);
const PR_NUMBER_REGEX = /\/pull\/(\d+)/;
const GITHUB_REMOTE_REGEX = /github\.com[:/]([^/]+\/[^/\s]+?)(?:\.git)?$/;
const GIT_SUFFIX_REGEX = /\.git$/;

/** Run a command and return its trimmed stdout. */
export async function runRead(
  cwd: string | undefined,
  command: string,
  args: string[]
): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    encoding: "utf-8",
    env: await withPathEnv(),
  });
  return stdout.trim();
}

/** Run a command for its side effect, discarding stdout. */
export async function run(
  cwd: string | undefined,
  command: string,
  args: string[]
): Promise<void> {
  await execFileAsync(command, args, {
    cwd,
    encoding: "utf-8",
    env: await withPathEnv(),
  });
}

export function withPathEnv(): Promise<NodeJS.ProcessEnv> {
  return getShellEnv();
}

/** Resolve `owner/repo` from the checkout's `origin` remote, or "" if unknown. */
export async function getRepoSlug(cwd: string): Promise<string> {
  try {
    const remoteUrl = await runRead(cwd, getResolvedGitPath(), [
      "remote",
      "get-url",
      "origin",
    ]);
    const match = GITHUB_REMOTE_REGEX.exec(remoteUrl);
    return match ? match[1].replace(GIT_SUFFIX_REGEX, "") : "";
  } catch {
    return "";
  }
}

/** Extract a PR number from a `.../pull/<n>` URL. */
export function parsePrNumber(url: string): number | null {
  const match = PR_NUMBER_REGEX.exec(url.trim());
  if (!match) {
    return null;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Map a raw `gh`/`git` failure onto an operator-readable message. */
export function parseGhError(error: unknown): string {
  const message = String(error);

  if (message.includes("not logged in") || message.includes("authentication")) {
    return "GitHub CLI not authenticated. Run 'gh auth login' in terminal.";
  }
  if (message.includes("already exists")) {
    return "A pull request already exists for this branch.";
  }
  if (
    message.includes("No commits between") ||
    message.includes("no commits")
  ) {
    return "No commits to create a PR. Make sure changes are committed first.";
  }
  if (message.includes("uncommitted changes")) {
    return "You have uncommitted changes. Commit them first.";
  }
  if (message.includes("not a git repository")) {
    return "Not a git repository.";
  }
  if (message.includes("permission denied") || message.includes("403")) {
    return "Permission denied. Check your GitHub access.";
  }
  if (message.includes("not found") || message.includes("404")) {
    return "Repository not found or no access.";
  }
  if (message.includes("network") || isNetworkError(message)) {
    return "Network error. Check your connection.";
  }

  return "Failed to complete GitHub operation. Check logs for details.";
}

/** Narrow a JSON body field to a non-blank string. */
export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** Narrow a JSON body field to a finite number (accepting numeric strings). */
export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}
