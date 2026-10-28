import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getShellEnv } from "../shell-path.js";
import { getResolvedGitPathAsync } from "./binary-path-overrides.js";

/**
 * Shared process/plumbing helpers for git-backed PR gateway routes.
 */

const execFileAsync = promisify(execFile);
const GITHUB_REMOTE_REGEX = /github\.com[:/]([^/]+\/[^/\s]+?)(?:\.git)?$/;
const GIT_SUFFIX_REGEX = /\.git$/;

export type GitRunOptions = {
  timeoutMs?: number;
};

export type GitRemoteRepoSlugs = {
  fetchRepoFullName: string;
  pushRepoFullName: string;
};

/** Run a command and return its trimmed stdout. */
export async function runRead(
  cwd: string | undefined,
  command: string,
  args: string[],
  options: GitRunOptions = {}
): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    encoding: "utf-8",
    env: await withPathEnv(),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  });
  return stdout.trim();
}

/** Run a command for its side effect, discarding stdout. */
export async function run(
  cwd: string | undefined,
  command: string,
  args: string[],
  options: GitRunOptions = {}
): Promise<void> {
  await execFileAsync(command, args, {
    cwd,
    encoding: "utf-8",
    env: await withPathEnv(),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  });
}

export function withPathEnv(): Promise<NodeJS.ProcessEnv> {
  return getShellEnv();
}

/** Resolve `owner/repo` from the checkout's `origin` remote, or "" if unknown. */
export function getRepoSlug(cwd: string): Promise<string> {
  return getRepoSlugFromRemote(cwd, ["remote", "get-url", "origin"]);
}

export async function getRemoteRepoSlugs(
  cwd: string
): Promise<GitRemoteRepoSlugs> {
  const fetchRepoFullName = await getRepoSlug(cwd);
  const pushRepoFullName =
    (await getRepoSlugFromRemote(cwd, [
      "remote",
      "get-url",
      "--push",
      "origin",
    ])) || fetchRepoFullName;
  return { fetchRepoFullName, pushRepoFullName };
}

async function getRepoSlugFromRemote(
  cwd: string,
  args: string[]
): Promise<string> {
  try {
    const remoteUrl = await runRead(cwd, await getResolvedGitPathAsync(), args);
    const match = GITHUB_REMOTE_REGEX.exec(remoteUrl);
    return match ? match[1].replace(GIT_SUFFIX_REGEX, "") : "";
  } catch {
    return "";
  }
}

/** Narrow a JSON body field to a non-blank string. */
export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
