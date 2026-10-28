/**
 * ISS-12552 (PRD-800): the facts the write-to-commit join
 * reads. A file write records a call that wrote files and the paths it wrote;
 * a git write records a commit, push or PR create, the branch it named, and
 * the changed files its own output lists. Each records what the call did,
 * successful or not; the join decides what proves. These stay on the Desktop:
 * only the join's per-branch result is synced, so no path leaves the device
 * (Daveth Oakhurst, 2026-10-20).
 *
 * Commits are read here, on the branch the commit's own output names or the
 * branch the session last checked out, since a quiet commit (`-q`) names
 * none. Pushes and PR creates come from the caller (Desktop's artifact-ref
 * extractor reads their branches), by position in the tool-use stream.
 */
import { ToolResultState } from "@repo/api/src/types/operation-claims";
import { extractDiffFilePaths } from "../harness/codex/codex-diff-stats";
import { isShellCommandToolUse, shellCommand } from "../harness/parser-utils";
import type { IndexedToolUse } from "../harness/session-tool-uses";
import type { NormalizedToolUse } from "../harness/types";
import { resultStateOf } from "./claim-result-state";

/** What a git write did. */
export const GitWriteAction = {
  Commit: "commit",
  Push: "push",
  PullRequestCreate: "prCreate",
} as const;
export type GitWriteAction =
  (typeof GitWriteAction)[keyof typeof GitWriteAction];

export const RepositoryActivityKind = {
  FileWrite: "fileWrite",
  GitWrite: "gitWrite",
} as const;
export type RepositoryActivityKind =
  (typeof RepositoryActivityKind)[keyof typeof RepositoryActivityKind];

/** One call's file write or git write, as the join reads it. */
export type RepositoryActivity = {
  key: string;
  kind: RepositoryActivityKind;
  resultState: ToolResultState;
  requestKey?: string;
  invokedAt?: string;
  /** A file write's paths, as the call wrote them. */
  paths?: string[];
  gitAction?: GitWriteAction;
  /** The branch a git write named. */
  branch?: string;
  /** The changed files a commit's own output lists, as it lists them. */
  changedPaths?: string[];
  /** The changed-file count a commit's own output reports. */
  filesChanged?: number;
};

/**
 * A push or PR create the caller found in the tool-use stream. Commits are
 * read here, where the checked-out branch is known.
 */
export type GitWriteInput = {
  toolIndex: number;
  branch: string;
  action: Exclude<GitWriteAction, typeof GitWriteAction.Commit>;
};

/** Tools whose input names the one file they write. */
const FILE_PATH_TOOLS: ReadonlyMap<string, string> = new Map([
  ["Write", "file_path"],
  ["Edit", "file_path"],
  ["MultiEdit", "file_path"],
  ["NotebookEdit", "notebook_path"],
]);
const PATCH_TOOLS: ReadonlySet<string> = new Set(["apply_patch"]);

const CREATE_DELETE_MODE_RE = /^\s*(?:create|delete) mode \d+ (.+)$/;
const STAT_LINE_RE = /^\s*(.+?)\s+\|\s+(?:\d+|Bin\b)/;
const FILES_CHANGED_RE = /(\d+) files? changed/;
const RENAME_RE = /^\s*rename (.+) \(\d+%\)$/;
const COMMIT_SUMMARY_BRANCH_RE = /^\[([^\s\]]+)\s+[0-9a-f]{7,40}\]/m;
const SWITCHED_TO_BRANCH_RE = /Switched to (?:a new )?branch '([^']+)'/;
const BRANCH_NAME_RE = /^[\w./-]+$/;
const COMMAND_SEPARATOR_RE = /&&|\|\||;|\||\n/;
const TOKEN_RE = /'[^']*'|"[^"]*"|\S+/g;
const QUOTE_RE = /^['"]|['"]$/g;
const GIT_GLOBAL_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-c",
  "-C",
]);
const CHECKOUT_NEW_FLAGS: ReadonlySet<string> = new Set(["-b", "-B"]);
const SWITCH_NEW_FLAGS: ReadonlySet<string> = new Set(["-c", "-C"]);

export function repositoryActivity(
  harness: string,
  calls: readonly IndexedToolUse[],
  gitWrites: readonly GitWriteInput[]
): RepositoryActivity[] {
  const claims: RepositoryActivity[] = [];
  const tracker = createBranchTracker();
  for (const call of calls) {
    const paths = fileWritePaths(call.tu);
    if (paths.length > 0) {
      claims.push({
        ...callFields(harness, "write", call),
        kind: RepositoryActivityKind.FileWrite,
        paths,
      });
    }
    claims.push(...commitClaims(harness, call, tracker));
  }
  const byIndex = new Map(calls.map((call) => [call.toolIndex, call]));
  const seen = new Set<string>();
  for (const write of gitWrites) {
    const call = byIndex.get(write.toolIndex);
    // One call can push and create a PR, or name two branches: one claim each.
    const kind = `git:${write.action}:${write.branch}`;
    const seenKey = `${write.toolIndex}\u0000${kind}`;
    if (!call || seen.has(seenKey)) {
      continue;
    }
    seen.add(seenKey);
    claims.push({
      ...callFields(harness, kind, call),
      kind: RepositoryActivityKind.GitWrite,
      gitAction: write.action,
      branch: write.branch,
    });
  }
  return claims;
}

/**
 * A shell call's commits, each on the branch its own output names, else the
 * branch this call or an earlier successful one checked out. Updates the
 * tracker with any branch this call switches to.
 */
function commitClaims(
  harness: string,
  call: IndexedToolUse,
  tracker: BranchTracker
): RepositoryActivity[] {
  if (!isShellCommandToolUse(call.tu)) {
    return [];
  }
  const succeeded = resultStateOf(call.tu) === ToolResultState.Present;
  const output = outputText(call.tu.output);
  let branch = tracker.current;
  let committed = false;
  let readsBranch = false;
  for (const segment of commandSegments(shellCommand(call.tu))) {
    const git = gitInvocation(segment);
    if (!git) {
      continue;
    }
    committed ||= git.subcommand === "commit";
    readsBranch ||= reportsBranch(git);
    branch = switchedBranch(git) ?? branch;
  }
  const reported = readsBranch ? reportedBranch(output) : undefined;
  if (succeeded) {
    tracker.current = reported ?? branch;
  }
  const commitBranch = COMMIT_SUMMARY_BRANCH_RE.exec(output)?.[1] ?? branch;
  if (!(committed && commitBranch)) {
    return [];
  }
  const listing = commitListing(call.tu.output);
  const kind = `git:${GitWriteAction.Commit}:${commitBranch}`;
  return [
    {
      ...callFields(harness, kind, call),
      kind: RepositoryActivityKind.GitWrite,
      gitAction: GitWriteAction.Commit,
      branch: commitBranch,
      ...(listing.changedPaths.length > 0
        ? { changedPaths: listing.changedPaths }
        : {}),
      ...(listing.filesChanged === undefined
        ? {}
        : { filesChanged: listing.filesChanged }),
    },
  ];
}

type BranchTracker = { current: string | undefined };

function createBranchTracker(): BranchTracker {
  return { current: undefined };
}

type GitInvocation = { subcommand: string; args: string[] };

/** `git [global options] <subcommand> args`, or null for any other command. */
function gitInvocation(tokens: readonly string[]): GitInvocation | null {
  const [program, ...rest] = tokens;
  if (!(program === "git" || program?.endsWith("/git"))) {
    return null;
  }
  let i = 0;
  while (i < rest.length) {
    const token = rest[i] ?? "";
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(token)) {
      i += 2;
    } else if (token.startsWith("-")) {
      i += 1;
    } else {
      return { subcommand: token, args: rest.slice(i + 1) };
    }
  }
  return null;
}

/** The branch a checkout or switch creates or moves to, when the command names it. */
function switchedBranch(git: GitInvocation): string | undefined {
  if (git.subcommand !== "checkout" && git.subcommand !== "switch") {
    return;
  }
  const flags =
    git.subcommand === "checkout" ? CHECKOUT_NEW_FLAGS : SWITCH_NEW_FLAGS;
  const flagAt = git.args.findIndex((arg) => flags.has(arg));
  if (flagAt >= 0) {
    return git.args[flagAt + 1];
  }
  if (git.subcommand === "switch") {
    return git.args.find((arg) => !arg.startsWith("-"));
  }
  return;
}

/** Whether a git command's output names the checked-out branch. */
function reportsBranch(git: GitInvocation): boolean {
  return (
    git.subcommand === "checkout" ||
    git.subcommand === "switch" ||
    (git.subcommand === "branch" && git.args.includes("--show-current")) ||
    (git.subcommand === "rev-parse" && git.args.includes("--abbrev-ref"))
  );
}

/** A branch the output itself reports as checked out. */
function reportedBranch(output: string): string | undefined {
  const switched = SWITCHED_TO_BRANCH_RE.exec(output)?.[1];
  if (switched) {
    return switched;
  }
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const [only] = lines;
  return lines.length === 1 && only && BRANCH_NAME_RE.test(only)
    ? only
    : undefined;
}

/** A command string's simple commands, each as whitespace tokens, quotes dropped. */
function commandSegments(command: string): string[][] {
  return command
    .split(COMMAND_SEPARATOR_RE)
    .map((segment) =>
      (segment.match(TOKEN_RE) ?? []).map((token) =>
        token.replace(QUOTE_RE, "")
      )
    )
    .filter((tokens) => tokens.length > 0);
}

/** The paths a file-mutation call wrote; none for any other call. */
export function fileWritePaths(tu: NormalizedToolUse): string[] {
  const input =
    tu.input && typeof tu.input === "object"
      ? (tu.input as Record<string, unknown>)
      : {};
  const key = FILE_PATH_TOOLS.get(tu.name);
  if (key) {
    const path = input[key];
    return typeof path === "string" && path.length > 0 ? [path] : [];
  }
  if (PATCH_TOOLS.has(tu.name)) {
    const patch =
      typeof tu.input === "string"
        ? tu.input
        : [input.input, input.patch].find((v) => typeof v === "string");
    return typeof patch === "string"
      ? [...new Set(extractDiffFilePaths(patch))]
      : [];
  }
  return [];
}

/** The changed files and count a commit's own output reports. */
export function commitListing(output: unknown): {
  changedPaths: string[];
  filesChanged?: number;
} {
  const text = outputText(output);
  const paths = new Set<string>();
  let filesChanged: number | undefined;
  for (const line of text.split("\n")) {
    const counted = FILES_CHANGED_RE.exec(line);
    if (counted?.[1]) {
      filesChanged = Number(counted[1]);
    }
    const listed =
      CREATE_DELETE_MODE_RE.exec(line)?.[1] ??
      RENAME_RE.exec(line)?.[1] ??
      STAT_LINE_RE.exec(line)?.[1];
    if (listed) {
      paths.add(listed.trim());
    }
  }
  return {
    changedPaths: [...paths],
    ...(filesChanged === undefined ? {} : { filesChanged }),
  };
}

function outputText(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  if (Array.isArray(output)) {
    return output.map(outputText).join("\n");
  }
  if (output && typeof output === "object") {
    return Object.values(output as Record<string, unknown>)
      .map(outputText)
      .join("\n");
  }
  return "";
}

function callFields(
  harness: string,
  kind: string,
  call: IndexedToolUse
): Omit<RepositoryActivity, "kind"> {
  const callId = call.tu.providerToolUseId ?? call.tu.id;
  return {
    key: callId
      ? `${harness}:${kind}:${callId}`
      : `${harness}:${kind}:ordinal:${call.toolIndex}`,
    resultState: resultStateOf(call.tu),
    ...(call.tu.requestKey ? { requestKey: call.tu.requestKey } : {}),
    ...(call.tu.timestamp ? { invokedAt: call.tu.timestamp } : {}),
  };
}
