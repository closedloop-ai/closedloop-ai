import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import type { ProcessManager } from "../process-manager.js";
import { assertPathAllowed, DirectoryNotAllowedError } from "../security.js";
import { parseBody } from "./parse-body.js";
import { json } from "./response-utils.js";
import { getResolvedGitPath } from "./symphony-loop.js";
import { expandHome } from "./symphony-utils.js";

export const GitLocalChangesRoute = {
  List: "/api/gateway/git/local-changes",
  Diff: "/api/gateway/git/local-changes/diff",
  CommitPush: "/api/gateway/git/local-changes/commit-push",
} as const;

const LOCAL_GIT_TIMEOUT_MS = 10_000;
const BINARY_SNIFF_BYTES = 8192;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

type LocalChangeStatus =
  | "added"
  | "modified"
  | "removed"
  | "renamed"
  | "copied";

type LocalFile = {
  path: string;
  previousPath: string | null;
  status: LocalChangeStatus;
  additions: number;
  deletions: number;
  patch: null;
};

type ParsedStatusLine = {
  code: string;
  filePath: string;
  previousPath: string | null;
  status: LocalChangeStatus;
};

type GitReadResult =
  | { ok: true; stdout: string; stderr: string }
  | {
      ok: false;
      stdout: string;
      stderr: string;
      exitCode: number;
      errorCode?: string;
    };

type RemoteDestination = {
  fullName: string;
  host: string | null;
};

/**
 * Registers Branch View-specific local git operations. These routes expose
 * Desktop-owned live working-tree state without broadening the generic
 * `/api/gateway/git` action contract.
 */
export function registerGitLocalChangesRoutes(
  dispatcher: OperationDispatcher,
  processManager: ProcessManager,
  getAllowedDirectories: () => string[]
): void {
  dispatcher.register("GET", GitLocalChangesRoute.List, async (context) => {
    const repoPath = context.query.get("repoPath");
    const repoFullName = context.query.get("repoFullName");
    const headBranch = context.query.get("headBranch");
    const validation = await validateRepoRequest({
      repoPath,
      repoFullName,
      headBranch,
      getAllowedDirectories,
      processManager,
      requirePushRemote: false,
    });
    if (!validation.ok) {
      json(context, validation.status, validation.payload);
      return;
    }

    const status = await readLocalStatus(processManager, validation.repoPath);
    if (!status.ok) {
      json(context, status.status, status.payload);
      return;
    }

    json(context, 200, {
      repoPath: validation.repoPath,
      branch: validation.branch,
      files: status.files,
    });
  });

  dispatcher.register("POST", GitLocalChangesRoute.Diff, async (context) => {
    const body = parseBody(context);
    if (!body) {
      json(context, 400, localError("invalid_json", "Invalid JSON body"));
      return;
    }

    const validation = await validateRepoRequest({
      repoPath: readString(body.repoPath),
      repoFullName: readString(body.repoFullName),
      headBranch: readString(body.headBranch),
      getAllowedDirectories,
      processManager,
      requirePushRemote: false,
    });
    if (!validation.ok) {
      json(context, validation.status, validation.payload);
      return;
    }

    const filePath = readString(body.path);
    const previousPath = readNullableString(body.previousPath);
    if (!filePath) {
      json(context, 400, localError("missing_path", "path is required"));
      return;
    }

    const diff = await readLocalDiff(
      processManager,
      validation.repoPath,
      filePath,
      previousPath
    );
    if (!diff.ok) {
      json(context, diff.status, diff.payload);
      return;
    }
    json(context, 200, diff.payload);
  });

  dispatcher.register(
    "POST",
    GitLocalChangesRoute.CommitPush,
    async (context) => {
      const body = parseBody(context);
      if (!body) {
        json(context, 400, localError("invalid_json", "Invalid JSON body"));
        return;
      }

      const validation = await validateRepoRequest({
        repoPath: readString(body.repoPath),
        repoFullName: readString(body.repoFullName),
        headBranch: readString(body.headBranch),
        getAllowedDirectories,
        processManager,
        requirePushRemote: true,
      });
      if (!validation.ok) {
        json(context, validation.status, validation.payload);
        return;
      }

      const message = readString(body.message)?.trim();
      if (!message) {
        json(
          context,
          400,
          localError("missing_message", "message is required")
        );
        return;
      }

      const result = await commitAndPushLocalChanges(
        processManager,
        validation.repoPath,
        validation.branch,
        message
      );
      if (!result.ok) {
        json(context, result.status, result.payload);
        return;
      }
      json(context, 200, result.payload);
    }
  );
}

async function validateRepoRequest(input: {
  repoPath: string | null;
  repoFullName: string | null;
  headBranch: string | null;
  getAllowedDirectories: () => string[];
  processManager: ProcessManager;
  requirePushRemote: boolean;
}): Promise<
  | { ok: true; repoPath: string; branch: string }
  | { ok: false; status: number; payload: Record<string, unknown> }
> {
  if (!(input.repoPath && input.repoFullName && input.headBranch)) {
    return {
      ok: false,
      status: 400,
      payload: localError(
        "missing_identity",
        "repoPath, repoFullName, and headBranch are required"
      ),
    };
  }

  const expandedRepoPath = expandHome(input.repoPath);
  try {
    assertPathAllowed(expandedRepoPath, input.getAllowedDirectories());
    await fs.access(expandedRepoPath, fsConstants.F_OK);
  } catch (error) {
    if (error instanceof DirectoryNotAllowedError) {
      return {
        ok: false,
        status: 403,
        payload: localError("repo_not_allowed", "directory not allowed"),
      };
    }
    return {
      ok: false,
      status: 404,
      payload: localError("repo_not_found", "repository not found"),
    };
  }

  const branch = await gitRead(input.processManager, expandedRepoPath, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  if (!branch.ok) {
    return {
      ok: false,
      status: 500,
      payload: gitFailure("branch_lookup_failed", branch),
    };
  }
  if (branch.stdout.trim() !== input.headBranch) {
    return {
      ok: false,
      status: 409,
      payload: localError(
        "branch_mismatch",
        "current branch does not match requested headBranch",
        {
          currentBranch: branch.stdout.trim(),
          expectedBranch: input.headBranch,
        }
      ),
    };
  }

  const remote = await gitRead(input.processManager, expandedRepoPath, [
    "remote",
    "get-url",
    "origin",
  ]);
  if (!remote.ok) {
    return {
      ok: false,
      status: 409,
      payload: localError("missing_origin", "origin remote is required"),
    };
  }
  const originDestination = parseRemoteDestination(remote.stdout.trim());
  if (originDestination?.fullName !== input.repoFullName) {
    return {
      ok: false,
      status: 409,
      payload: localError(
        "repo_mismatch",
        "origin remote does not match requested repoFullName",
        {
          actualRepoFullName: originDestination?.fullName ?? null,
          expectedRepoFullName: input.repoFullName,
        }
      ),
    };
  }

  if (input.requirePushRemote) {
    const pushRemote = await gitRead(input.processManager, expandedRepoPath, [
      "remote",
      "get-url",
      "--push",
      "--all",
      "origin",
    ]);
    if (!pushRemote.ok) {
      return {
        ok: false,
        status: 409,
        payload: localError(
          "missing_push_origin",
          "origin push remote is required"
        ),
      };
    }
    const pushDestinations = pushRemote.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseRemoteDestination);
    if (
      pushDestinations.length !== 1 ||
      pushDestinations.some((destination) => !destination)
    ) {
      return {
        ok: false,
        status: 409,
        payload: localError(
          "ambiguous_push_origin",
          "origin must have exactly one canonical push destination",
          {
            actualPushDestinations: pushDestinations,
            expectedRepoFullName: input.repoFullName,
          }
        ),
      };
    }
    const [pushDestination] = pushDestinations as [RemoteDestination];
    if (
      pushDestination.fullName !== input.repoFullName ||
      (pushDestination.host !== null && pushDestination.host !== "github.com")
    ) {
      return {
        ok: false,
        status: 409,
        payload: localError(
          "push_repo_mismatch",
          "origin push remote must be the canonical requested GitHub repo",
          {
            actualRepoFullName: pushDestination.fullName,
            actualHost: pushDestination.host,
            expectedRepoFullName: input.repoFullName,
          }
        ),
      };
    }
  }

  return { ok: true, repoPath: expandedRepoPath, branch: branch.stdout.trim() };
}

async function readLocalStatus(
  processManager: ProcessManager,
  repoPath: string
): Promise<
  | { ok: true; files: LocalFile[] }
  | { ok: false; status: number; payload: Record<string, unknown> }
> {
  const statusResult = await gitRead(processManager, repoPath, [
    "status",
    "--porcelain=v1",
    "--renames",
    "--find-renames",
    "--untracked-files=all",
  ]);
  if (!statusResult.ok) {
    return {
      ok: false,
      status: 500,
      payload: gitFailure("status_failed", statusResult),
    };
  }

  const parsed = statusResult.stdout
    .split("\n")
    .map(parseStatusLine)
    .filter((line): line is ParsedStatusLine => Boolean(line));
  const stats = await readNumstat(processManager, repoPath);
  const files = await Promise.all(
    parsed.map(async (line) => {
      const lineStats =
        stats.get(line.filePath) ??
        (line.code === "??"
          ? await readUntrackedTextStats(repoPath, line.filePath)
          : null);
      return {
        path: line.filePath,
        previousPath: line.previousPath,
        status: line.status,
        additions: lineStats?.additions ?? 0,
        deletions: lineStats?.deletions ?? 0,
        patch: null,
      };
    })
  );

  return { ok: true, files };
}

async function readLocalDiff(
  processManager: ProcessManager,
  repoPath: string,
  filePath: string,
  previousPath: string | null
): Promise<
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; status: number; payload: Record<string, unknown> }
> {
  const safePath = await validateGitRelativePath(repoPath, filePath);
  if (!safePath.ok) {
    return { ok: false, status: safePath.status, payload: safePath.payload };
  }
  if (previousPath) {
    const safePrevious = await validateGitRelativePath(repoPath, previousPath);
    if (!safePrevious.ok) {
      return {
        ok: false,
        status: safePrevious.status,
        payload: safePrevious.payload,
      };
    }
  }

  const statusResult = await gitRead(processManager, repoPath, [
    "status",
    "--porcelain=v1",
    "--renames",
    "--",
    filePath,
  ]);
  if (!statusResult.ok) {
    return {
      ok: false,
      status: 500,
      payload: gitFailure("status_failed", statusResult),
    };
  }
  const statusLine = statusResult.stdout
    .split("\n")
    .map(parseStatusLine)
    .find((line) => line?.filePath === filePath);
  if (!statusLine) {
    return {
      ok: false,
      status: 404,
      payload: localError("no_local_changes", "file has no local changes"),
    };
  }

  const binaryResult = await gitRead(processManager, repoPath, [
    "diff",
    "--numstat",
    "HEAD",
    "--",
    filePath,
  ]);
  const isBinary =
    binaryResult.ok && binaryResult.stdout.trim().startsWith("-\t-");
  const oldPath = previousPath ?? statusLine.previousPath ?? filePath;
  const isNew = statusLine.status === "added";
  const isDeleted = statusLine.status === "removed";
  if (isBinary) {
    return {
      ok: true,
      payload: {
        path: filePath,
        oldContent: "",
        newContent: "",
        isNew,
        isDeleted,
        isBinary: true,
      },
    };
  }

  const oldContent = isNew
    ? ""
    : await readHeadContent(processManager, repoPath, oldPath);
  const workingFile = isDeleted
    ? { isBinary: false, content: "" }
    : await readWorkingFile(repoPath, filePath);
  if (workingFile.isBinary) {
    return {
      ok: true,
      payload: {
        path: filePath,
        oldContent: "",
        newContent: "",
        isNew,
        isDeleted,
        isBinary: true,
      },
    };
  }

  return {
    ok: true,
    payload: {
      path: filePath,
      oldContent,
      newContent: workingFile.content,
      isNew,
      isDeleted,
      isBinary: false,
    },
  };
}

async function commitAndPushLocalChanges(
  processManager: ProcessManager,
  repoPath: string,
  headBranch: string,
  message: string
): Promise<
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; status: number; payload: Record<string, unknown> }
> {
  const status = await readLocalStatus(processManager, repoPath);
  if (!status.ok) {
    return status;
  }
  if (status.files.length === 0) {
    return {
      ok: false,
      status: 409,
      payload: localError("no_local_changes", "no local changes to commit"),
    };
  }

  const add = await gitRead(processManager, repoPath, ["add", "--all"]);
  if (!add.ok) {
    return {
      ok: false,
      status: 500,
      payload: gitFailure("git_add_failed", add),
    };
  }
  const commit = await gitRead(processManager, repoPath, [
    "commit",
    "-m",
    message,
  ]);
  if (!commit.ok) {
    return {
      ok: false,
      status: 500,
      payload: gitFailure("git_commit_failed", commit),
    };
  }
  const sha = await gitRead(processManager, repoPath, ["rev-parse", "HEAD"]);
  if (!sha.ok) {
    return {
      ok: false,
      status: 500,
      payload: gitFailure("commit_sha_failed", sha),
    };
  }
  const push = await gitRead(processManager, repoPath, [
    "push",
    "origin",
    `HEAD:${headBranch}`,
  ]);
  if (!push.ok) {
    return {
      ok: false,
      status: 500,
      payload: gitFailure("git_push_failed", push),
    };
  }

  return {
    ok: true,
    payload: {
      success: true,
      commitSha: sha.stdout.trim(),
      branch: headBranch,
      pushed: true,
      filesCommitted: status.files.length,
    },
  };
}

async function readNumstat(
  processManager: ProcessManager,
  repoPath: string
): Promise<Map<string, { additions: number; deletions: number }>> {
  const result = await gitRead(processManager, repoPath, [
    "diff",
    "--numstat",
    "HEAD",
  ]);
  const stats = new Map<string, { additions: number; deletions: number }>();
  if (!result.ok) {
    return stats;
  }
  for (const line of result.stdout.split("\n")) {
    const [additions, deletions, filePath] = line.split("\t");
    if (!filePath || additions === "-" || deletions === "-") {
      continue;
    }
    stats.set(filePath, {
      additions: Number.parseInt(additions, 10) || 0,
      deletions: Number.parseInt(deletions, 10) || 0,
    });
  }
  return stats;
}

function parseStatusLine(line: string): ParsedStatusLine | null {
  if (!line.trim()) {
    return null;
  }
  const code = line.slice(0, 2);
  const payload = line.slice(3).trim();
  if (!payload) {
    return null;
  }
  const renameParts =
    code.includes("R") || code.includes("C")
      ? splitRenamePayload(payload)
      : null;
  const previousPath = renameParts
    ? unquoteGitPath(renameParts.previousPath)
    : null;
  const filePath = unquoteGitPath(renameParts ? renameParts.filePath : payload);
  const status = classifyStatus(code);
  return { code, filePath, previousPath, status };
}

function splitRenamePayload(
  payload: string
): { previousPath: string; filePath: string } | null {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < payload.length; index += 1) {
    const char = payload[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && payload.startsWith(" -> ", index)) {
      return {
        previousPath: payload.slice(0, index),
        filePath: payload.slice(index + 4),
      };
    }
  }
  return null;
}

function classifyStatus(code: string): LocalChangeStatus {
  if (code.includes("R")) {
    return "renamed";
  }
  if (code.includes("C")) {
    return "copied";
  }
  if (code === "??" || code.includes("A")) {
    return "added";
  }
  if (code.includes("D")) {
    return "removed";
  }
  return "modified";
}

async function validateGitRelativePath(
  repoPath: string,
  filePath: string
): Promise<
  { ok: true } | { ok: false; status: number; payload: Record<string, unknown> }
> {
  if (filePath.includes("\0") || path.isAbsolute(filePath)) {
    return {
      ok: false,
      status: 400,
      payload: localError("invalid_path", "path must be git-relative"),
    };
  }
  const normalized = path.normalize(filePath);
  if (
    normalized === "." ||
    normalized.startsWith("..") ||
    normalized.includes(`${path.sep}..${path.sep}`)
  ) {
    return {
      ok: false,
      status: 400,
      payload: localError(
        "invalid_path",
        "path must stay inside the repository"
      ),
    };
  }
  const repoReal = await fs.realpath(repoPath);
  const absolute = path.join(repoPath, normalized);
  try {
    const targetReal = await fs.realpath(absolute);
    if (!isPathInside(targetReal, repoReal)) {
      return {
        ok: false,
        status: 403,
        payload: localError("path_escape", "path escapes repository"),
      };
    }
  } catch {
    if (!isPathInside(path.resolve(absolute), repoReal)) {
      return {
        ok: false,
        status: 403,
        payload: localError("path_escape", "path escapes repository"),
      };
    }
  }
  return { ok: true };
}

async function readHeadContent(
  processManager: ProcessManager,
  repoPath: string,
  filePath: string
): Promise<string> {
  const result = await gitRead(processManager, repoPath, [
    "show",
    `HEAD:${filePath}`,
  ]);
  return result.ok ? result.stdout : "";
}

async function readWorkingFile(
  repoPath: string,
  filePath: string
): Promise<{ isBinary: boolean; content: string }> {
  try {
    const buffer = await fs.readFile(path.join(repoPath, filePath));
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      return { isBinary: true, content: "" };
    }
    return {
      isBinary: false,
      content: buffer.toString("utf-8"),
    };
  } catch {
    return { isBinary: false, content: "" };
  }
}

async function readUntrackedTextStats(
  repoPath: string,
  filePath: string
): Promise<{ additions: number; deletions: number } | null> {
  try {
    const buffer = await fs.readFile(path.join(repoPath, filePath));
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      return { additions: 0, deletions: 0 };
    }
    const content = buffer.toString("utf-8");
    if (!content) {
      return { additions: 0, deletions: 0 };
    }
    const additions = content.endsWith("\n")
      ? content.split("\n").length - 1
      : content.split("\n").length;
    return { additions, deletions: 0 };
  } catch {
    return null;
  }
}

async function gitRead(
  processManager: ProcessManager,
  repoPath: string,
  args: string[]
): Promise<GitReadResult> {
  const result = await processManager.exec(
    getResolvedGitPath(),
    args,
    repoPath,
    {
      timeoutMs: LOCAL_GIT_TIMEOUT_MS,
    }
  );
  if (result.exitCode === 0) {
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  }
  return {
    ok: false,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
  };
}

function parseRemoteDestination(remoteUrl: string): RemoteDestination | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (
      url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "ssh:"
    ) {
      const fullName = fullNameFromPath(url.pathname);
      return fullName ? { fullName, host: url.hostname.toLowerCase() } : null;
    }
    if (url.protocol === "file:") {
      const fullName = fullNameFromPath(url.pathname);
      return fullName ? { fullName, host: null } : null;
    }
  } catch {
    // Fall through to scp-style SSH or local path parsing.
  }

  const scpMatch = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(trimmed);
  if (scpMatch) {
    const fullName = fullNameFromPath(scpMatch[2]);
    return fullName ? { fullName, host: scpMatch[1].toLowerCase() } : null;
  }

  const fullName = fullNameFromPath(trimmed);
  return fullName ? { fullName, host: null } : null;
}

function fullNameFromPath(remotePath: string): string | null {
  const normalized = remotePath.replaceAll("\\", "/").replace(/\/+$/, "");
  const match = /(?:^|\/)([^/]+\/[^/]+?)(?:\.git)?$/.exec(normalized);
  return match?.[1] ?? null;
}

function isPathInside(targetPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, targetPath);
  return (
    relative === "" || !(relative.startsWith("..") || path.isAbsolute(relative))
  );
}

function localError(
  code: string,
  error: string,
  details?: Record<string, unknown>
): Record<string, unknown> {
  return {
    error,
    code,
    ...(details ? { details } : {}),
  };
}

function gitFailure(
  code: string,
  result: {
    stdout: string;
    stderr: string;
    exitCode?: number;
    errorCode?: string;
  }
): Record<string, unknown> {
  const timedOut = "errorCode" in result && result.errorCode === "ETIMEDOUT";
  return localError(
    timedOut ? "git_timeout" : code,
    timedOut
      ? "git command timed out"
      : result.stderr.trim() || result.stdout.trim() || "git command failed",
    {
      exitCode: result.exitCode,
    }
  );
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function unquoteGitPath(input: string): string {
  if (!(input.startsWith('"') && input.endsWith('"'))) {
    return input;
  }
  const bytes: number[] = [];
  const content = input.slice(1, -1);
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (char !== "\\") {
      bytes.push(...textEncoder.encode(char));
      continue;
    }
    index += 1;
    if (index >= content.length) {
      bytes.push("\\".charCodeAt(0));
      break;
    }
    const escaped = content[index];
    const simpleEscape = simpleGitEscapeByte(escaped);
    if (simpleEscape !== null) {
      bytes.push(simpleEscape);
      continue;
    }
    if (isOctalDigit(escaped)) {
      let octal = escaped;
      while (
        index + 1 < content.length &&
        octal.length < 3 &&
        isOctalDigit(content[index + 1])
      ) {
        index += 1;
        octal += content[index];
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    bytes.push(...textEncoder.encode(escaped));
  }
  return textDecoder.decode(new Uint8Array(bytes));
}

function simpleGitEscapeByte(value: string): number | null {
  if (value === "a") {
    return 0x07;
  }
  if (value === "b") {
    return 0x08;
  }
  if (value === "f") {
    return 0x0c;
  }
  if (value === "n") {
    return 0x0a;
  }
  if (value === "r") {
    return 0x0d;
  }
  if (value === "t") {
    return 0x09;
  }
  if (value === "v") {
    return 0x0b;
  }
  if (value === "\\" || value === '"') {
    return value.charCodeAt(0);
  }
  return null;
}

function isOctalDigit(value: string): boolean {
  return value >= "0" && value <= "7";
}
