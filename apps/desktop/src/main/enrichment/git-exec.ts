import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REMOTE_FETCH_RE = /^(\S+)\s+(\S+)\s+\(fetch\)/;
const GITHUB_SSH_REPO_RE = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/;
const LEADING_SLASH_RE = /^\//;
const GIT_SUFFIX_RE = /\.git$/;

export async function gitExec(
  gitPath: string,
  args: string[],
  cwd: string,
  timeoutMs = 15_000
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(gitPath, args, {
      cwd,
      timeout: timeoutMs,
      env: { ...process.env, LC_ALL: "C" },
      maxBuffer: 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    if (typeof e.code === "number" || e.stdout != null) {
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
        exitCode: typeof e.code === "number" ? e.code : 1,
      };
    }
    throw err;
  }
}

export async function getRemoteUrl(
  gitPath: string,
  cwd: string,
  remote = "origin"
): Promise<string | null> {
  const { stdout, exitCode } = await gitExec(
    gitPath,
    ["remote", "get-url", remote],
    cwd
  );
  if (exitCode !== 0) {
    return null;
  }
  return stdout.trim() || null;
}

export async function listRemotes(
  gitPath: string,
  cwd: string
): Promise<Array<{ name: string; url: string }>> {
  const { stdout, exitCode } = await gitExec(gitPath, ["remote", "-v"], cwd);
  if (exitCode !== 0) {
    return [];
  }
  const seen = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const m = REMOTE_FETCH_RE.exec(line);
    if (m && !seen.has(m[1]!)) {
      seen.set(m[1]!, m[2]!);
    }
  }
  return [...seen.entries()].map(([name, url]) => ({ name, url }));
}

// Only GitHub remotes yield a `owner/repo` identity — downstream `gh` enrichment
// treats this value as a GitHub repo, so a GitLab/Bitbucket/self-hosted remote
// must stay local-only (null) rather than aliasing an unrelated GitHub repo.
export function normalizeRepoFullName(remoteUrl: string): string | null {
  const sshMatch = GITHUB_SSH_REPO_RE.exec(remoteUrl);
  if (sshMatch) {
    return sshMatch[1]!.toLowerCase();
  }
  try {
    const url = new URL(remoteUrl);
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
      return null;
    }
    const path = url.pathname
      .replace(LEADING_SLASH_RE, "")
      .replace(GIT_SUFFIX_RE, "");
    if (path.includes("/")) {
      return path.toLowerCase();
    }
  } catch {
    // not a URL
  }
  return null;
}

export async function getAbsoluteGitDir(
  gitPath: string,
  cwd: string
): Promise<string | null> {
  const { stdout, exitCode } = await gitExec(
    gitPath,
    ["rev-parse", "--path-format=absolute", "--git-dir"],
    cwd
  );
  if (exitCode !== 0) {
    return null;
  }
  return stdout.trim() || null;
}

export async function getAbsoluteGitCommonDir(
  gitPath: string,
  cwd: string
): Promise<string | null> {
  const { stdout, exitCode } = await gitExec(
    gitPath,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd
  );
  if (exitCode !== 0) {
    return null;
  }
  return stdout.trim() || null;
}

export async function isInsideWorkTree(
  gitPath: string,
  cwd: string
): Promise<boolean> {
  const { stdout, exitCode } = await gitExec(
    gitPath,
    ["rev-parse", "--is-inside-work-tree"],
    cwd
  );
  return exitCode === 0 && stdout.trim() === "true";
}

export async function getDefaultBranch(
  gitPath: string,
  cwd: string
): Promise<string> {
  const { stdout: symRef, exitCode: symExit } = await gitExec(
    gitPath,
    ["symbolic-ref", "refs/remotes/origin/HEAD"],
    cwd
  );
  if (symExit === 0 && symRef.trim()) {
    return symRef.trim().replace("refs/remotes/origin/", "");
  }
  for (const candidate of ["origin/main", "origin/master"]) {
    const { exitCode } = await gitExec(
      gitPath,
      ["rev-parse", "--verify", candidate],
      cwd
    );
    if (exitCode === 0) {
      return candidate.replace("origin/", "");
    }
  }
  const { stdout: headRef } = await gitExec(
    gitPath,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    cwd
  );
  return headRef.trim() || "main";
}
