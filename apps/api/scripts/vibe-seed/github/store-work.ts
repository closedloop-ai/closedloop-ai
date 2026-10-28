import { createHash } from "node:crypto";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  BRANCH_PUSH_METHODS,
} from "@repo/api/src/types/session-artifact-link";
import {
  VIBE_SEED_UNHOMED_LOGIN,
  vibeSeedPullRequestTopic,
} from "@repo/api/src/vibe-seed-corpus";
import { z } from "zod";
import { openSnapshot } from "../../perf-import-desktop-snapshot-reads";
import { type CorpusShift, shiftCorpusIso } from "../core/corpus-shift";
import {
  EDIT_TOOL_NAMES,
  type FileChange,
  FileChangeStatus,
  type FileEdit,
  foldFileEdits,
  parseFileEdits,
} from "./store-edits";
import type { StoreLink } from "./store-links";
import type { PullRequestFacts } from "./store-refs";

/**
 * ISS-12017: what each pushed golden branch did, recovered from the Desktop
 * store: the commits its sessions made (`git commit` messages from their shell
 * calls), the file changes (their edit tool calls), when each push landed (the
 * store's push links), and the pull request a session opened for it. Commit
 * SHAs are derived from the branch and message, because the store keeps the
 * subject line but not the object id.
 */

export type GitHubPerson = { readonly login: string; readonly id: number };

export type WorkCommit = {
  readonly sha: string;
  readonly message: string;
  readonly committedAt: Date;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly filesChanged: number;
};

export type WorkPush = {
  readonly at: Date;
  readonly beforeSha: string;
  readonly afterSha: string;
  /** The commits this push delivered, oldest first. */
  readonly commits: readonly WorkCommit[];
  readonly linesAdded: number;
  readonly linesRemoved: number;
};

export type WorkPullRequest = {
  readonly number: number;
  readonly openedAt: Date;
  readonly facts: PullRequestFacts;
};

export type BranchWork = {
  readonly repositoryFullName: string;
  readonly branchName: string;
  readonly author: GitHubPerson;
  readonly baseBranch: string;
  readonly commits: readonly WorkCommit[];
  readonly pushes: readonly WorkPush[];
  readonly files: readonly FileChange[];
  readonly pullRequests: readonly WorkPullRequest[];
};

const SHELL_TOOL_NAMES = ["Bash", "exec_command", "mcp__lc__bash"] as const;
const EVENT_SELECT = `
  SELECT
    e.session_id AS "sessionId",
    e.tool_name AS "toolName",
    e.git_branch AS "gitBranch",
    e.created_at AS "createdAt",
    json_type(e.data, '$.tool_input') AS "inputType",
    json_extract(e.data, '$.tool_input') AS "toolInput",
    s.cwd AS "cwd"
  FROM events e
  JOIN sessions s ON s.id = e.session_id
  WHERE e.tool_name IN (${[...EDIT_TOOL_NAMES].map((name) => `'${name}'`).join(", ")})
     OR (
       e.tool_name IN (${SHELL_TOOL_NAMES.map((name) => `'${name}'`).join(", ")})
       AND json_extract(e.data, '$.tool_input') LIKE '%git commit%'
     )
  ORDER BY e.created_at ASC, e.id ASC
`;

const eventRowSchema = z.object({
  sessionId: z.string().min(1),
  toolName: z.string().min(1),
  gitBranch: z.string().nullable(),
  createdAt: z.string().min(1),
  inputType: z.string().nullable(),
  toolInput: z.string().nullable(),
  cwd: z.string().nullable(),
});
type EventRow = z.infer<typeof eventRowSchema>;

const shellInputSchema = z.union([
  z.object({ command: z.union([z.string(), z.array(z.string())]) }),
  z.object({ cmd: z.string() }),
]);

const HEREDOC_COMMIT =
  /git commit[^\n]*?<<-?\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*?)\n\1(?:\n|$)/g;
const INLINE_COMMIT = /git commit[^\n<]*?-m\s+"([^"$`][^"]*)"/g;
const AMEND_FLAG = /\s--amend\b/;
const HOME_DIRECTORY = /^\/(?:Users|home)\/([^/]+)/;
const BRANCH_OWNER_PREFIX = /^([a-z][a-z0-9-]*)\//;
const TICKET_TOKEN = /(?:^|-)((?:fea|iss|pln|prd|pro)-\d+)(?=-|$)/i;
const NON_LOGIN_CHARACTER = /[^a-z0-9-]/gi;
const TRAILER_LINE = /^co-authored-by:/i;
export const COMMON_BRANCH_PREFIXES: ReadonlySet<string> = new Set([
  "bench",
  "bot",
  "chore",
  "ci",
  "docs",
  "feat",
  "feature",
  "fix",
  "refactor",
]);
const FALLBACK_LOGIN = VIBE_SEED_UNHOMED_LOGIN;
const HOUR_MS = 60 * 60 * 1000;
const REVIEW_MIN_HOURS = 24;
const REVIEW_SPREAD_HOURS = 73;
const DEFAULT_BASE_BRANCH = "main";

type CommitDraft = { message: string; at: number; edits: FileEdit[] };

type SessionTimeline = {
  pushes: { branchKey: string; at: number }[];
};

type BranchDraft = {
  repositoryFullName: string;
  branchName: string;
  author: GitHubPerson | null;
  pushes: number[];
  edits: { at: number; edit: FileEdit }[];
  commits: CommitDraft[];
  pullRequests: { number: number; openedAt: number }[];
};

/** The work of every branch a golden session pushed, keyed by `repo#branch`. */
export function readBranchWork(
  storePath: string,
  links: readonly StoreLink[],
  shift: CorpusShift
): ReadonlyMap<string, BranchWork> {
  const drafts = new Map<string, BranchDraft>();
  const timelines = buildTimelines(links, drafts);
  for (const row of readEventRows(storePath)) {
    applyEvent(row, timelines, drafts, shift);
  }
  const work = new Map<string, BranchWork>();
  for (const [key, draft] of drafts) {
    if (draft.pushes.length > 0) {
      work.set(key, finishBranch(draft, shift.nowMs));
    }
  }
  return work;
}

export function branchWorkKey(
  repositoryFullName: string,
  branchName: string
): string {
  return `${repositoryFullName.toLowerCase()}#${branchName}`;
}

/** A GitHub identity derived from a login, with a stable numeric id. */
export function gitHubPerson(login: string): GitHubPerson {
  const digest = createHash("sha256").update(login).digest();
  return { login, id: 41_000_000 + (digest.readUInt32BE(0) % 9_000_000) };
}

function buildTimelines(
  links: readonly StoreLink[],
  drafts: Map<string, BranchDraft>
): Map<string, SessionTimeline> {
  const timelines = new Map<string, SessionTimeline>();
  for (const link of links) {
    if (link.branchName === null || link.observedAt === undefined) {
      continue;
    }
    const at = Date.parse(link.observedAt);
    const key = branchWorkKey(link.repositoryFullName, link.branchName);
    const draft =
      drafts.get(key) ?? emptyDraft(link.repositoryFullName, link.branchName);
    drafts.set(key, draft);
    const timeline = timelines.get(link.sessionId) ?? { pushes: [] };
    timelines.set(link.sessionId, timeline);
    if (isPushLink(link)) {
      draft.pushes.push(at);
      draft.author ??= sessionPerson(link.cwd, link.branchName);
      timeline.pushes.push({ branchKey: key, at });
    } else if (
      link.kind === ArtifactRefTargetKind.PullRequest &&
      link.relation === ArtifactRefRelation.Created &&
      link.prNumber !== null &&
      !draft.pullRequests.some((pr) => pr.number === link.prNumber)
    ) {
      draft.pullRequests.push({ number: link.prNumber, openedAt: at });
    }
  }
  for (const timeline of timelines.values()) {
    timeline.pushes.sort(
      (a, b) => a.at - b.at || a.branchKey.localeCompare(b.branchKey)
    );
  }
  return timelines;
}

function applyEvent(
  row: EventRow,
  timelines: ReadonlyMap<string, SessionTimeline>,
  drafts: ReadonlyMap<string, BranchDraft>,
  shift: CorpusShift
): void {
  const timeline = timelines.get(row.sessionId);
  const shifted = shiftCorpusIso(row.createdAt, shift, { clampedToNow: 0 });
  if (timeline === undefined || typeof shifted !== "string") {
    return;
  }
  const at = Date.parse(shifted);
  const draft = eventBranch(timeline, row.gitBranch, at, drafts);
  if (draft === undefined) {
    return;
  }
  const input = parseToolInput(row);
  if ((SHELL_TOOL_NAMES as readonly string[]).includes(row.toolName)) {
    applyCommitCommand(draft, shellCommand(input), at);
    return;
  }
  for (const edit of parseFileEdits(row.toolName, input, row.cwd)) {
    draft.edits.push({ at, edit });
  }
}

/**
 * The branch an event worked on: the branch its own git metadata names when
 * the session pushed that branch, else the session's next push at or after
 * the event (work lands on the branch it is pushed to).
 */
function eventBranch(
  timeline: SessionTimeline,
  gitBranch: string | null,
  at: number,
  drafts: ReadonlyMap<string, BranchDraft>
): BranchDraft | undefined {
  const named = timeline.pushes.find(
    (push) => drafts.get(push.branchKey)?.branchName === gitBranch
  );
  const next = timeline.pushes.find((push) => push.at >= at);
  const key = (named ?? next)?.branchKey;
  return key === undefined ? undefined : drafts.get(key);
}

function applyCommitCommand(
  draft: BranchDraft,
  command: string | null,
  at: number
): void {
  if (command === null) {
    return;
  }
  for (const message of commitMessages(command)) {
    const previous = draft.commits.at(-1);
    if (
      previous &&
      (AMEND_FLAG.test(command) ||
        subjectOf(previous.message) === subjectOf(message))
    ) {
      previous.message = message;
      previous.at = at;
    } else {
      draft.commits.push({ message, at, edits: [] });
    }
  }
}

function finishBranch(draft: BranchDraft, nowMs: number): BranchWork {
  draft.pushes.sort((a, b) => a - b);
  draft.pullRequests.sort((a, b) => a.openedAt - b.openedAt);
  const fallbackMessage = humanizeBranchName(draft.branchName);
  const commitDrafts = commitsCoveringPushes(draft, fallbackMessage);
  if (draft.edits.length === 0) {
    draft.edits.push(...placeholderEdits(draft));
  }
  assignEditsToCommits(draft.edits, commitDrafts);
  const commits = commitDrafts.map((commit, index) =>
    toWorkCommit(draft, commit, index)
  );
  const files = foldFileEdits(draft.edits.map(({ edit }) => edit));
  const title =
    vibeSeedPullRequestTopic(draft.branchName)?.title ??
    subjectOf(commits[0]?.message ?? fallbackMessage);
  return {
    repositoryFullName: draft.repositoryFullName,
    branchName: draft.branchName,
    author: draft.author ?? gitHubPerson(FALLBACK_LOGIN),
    baseBranch: DEFAULT_BASE_BRANCH,
    commits,
    pushes: buildPushes(draft, commits),
    files,
    pullRequests: draft.pullRequests.map((pr, index) => ({
      number: pr.number,
      openedAt: new Date(pr.openedAt),
      facts: pullRequestFacts({
        number: pr.number,
        openedAt: pr.openedAt,
        supersededAt: draft.pullRequests[index + 1]?.openedAt ?? null,
        title,
        files,
        nowMs,
      }),
    })),
  };
}

/** Every push carries at least one commit; a push with none recorded gets one. */
function commitsCoveringPushes(
  draft: BranchDraft,
  fallbackMessage: string
): CommitDraft[] {
  const commits = [...draft.commits].sort((a, b) => a.at - b.at);
  let previousPush = Number.NEGATIVE_INFINITY;
  for (const push of draft.pushes) {
    const covered = commits.some(
      (commit) => commit.at > previousPush && commit.at <= push
    );
    if (!covered) {
      commits.push({ message: fallbackMessage, at: push, edits: [] });
    }
    previousPush = push;
  }
  return commits.sort((a, b) => a.at - b.at);
}

function assignEditsToCommits(
  edits: readonly { at: number; edit: FileEdit }[],
  commits: CommitDraft[]
): void {
  for (const { at, edit } of edits) {
    const target = commits.find((commit) => commit.at >= at) ?? commits.at(-1);
    target?.edits.push(edit);
  }
}

function toWorkCommit(
  draft: BranchDraft,
  commit: CommitDraft,
  index: number
): WorkCommit {
  const files = foldFileEdits(commit.edits);
  return {
    sha: derivedSha(
      `${draft.repositoryFullName}\0${draft.branchName}\0${index}\0${commit.message}`
    ),
    message: commit.message,
    committedAt: new Date(commit.at),
    linesAdded: files.reduce((sum, file) => sum + file.additions, 0),
    linesRemoved: files.reduce((sum, file) => sum + file.deletions, 0),
    filesChanged: files.length,
  };
}

function buildPushes(
  draft: BranchDraft,
  commits: readonly WorkCommit[]
): WorkPush[] {
  const pushes: WorkPush[] = [];
  let beforeSha = derivedSha(
    `${draft.repositoryFullName}\0${DEFAULT_BASE_BRANCH}\0${draft.branchName}`
  );
  let previousPush = Number.NEGATIVE_INFINITY;
  for (const push of draft.pushes) {
    const included = commits.filter(
      (commit) =>
        commit.committedAt.getTime() > previousPush &&
        commit.committedAt.getTime() <= push
    );
    const last = included.at(-1);
    if (last !== undefined) {
      pushes.push({
        at: new Date(push),
        beforeSha,
        afterSha: last.sha,
        commits: included,
        linesAdded: included.reduce(
          (sum, commit) => sum + commit.linesAdded,
          0
        ),
        linesRemoved: included.reduce(
          (sum, commit) => sum + commit.linesRemoved,
          0
        ),
      });
      beforeSha = last.sha;
    }
    previousPush = push;
  }
  return pushes;
}

/**
 * The facts `gh` would report today: a PR replaced by a later one on the same
 * branch is closed when its successor opens; otherwise it is reviewed for one
 * to four days (ISS-12135: a two-day ceiling left the corpus with no merge in
 * the last week) and then merged, every ninth closed unmerged, or still open
 * when that has not happened by now.
 */
function pullRequestFacts(input: {
  number: number;
  openedAt: number;
  supersededAt: number | null;
  title: string;
  files: readonly FileChange[];
  nowMs: number;
}): PullRequestFacts {
  const base = {
    title: input.title,
    isDraft: false,
    baseRef: DEFAULT_BASE_BRANCH,
    ...(input.files.length > 0
      ? {
          additions: input.files.reduce((sum, file) => sum + file.additions, 0),
          deletions: input.files.reduce((sum, file) => sum + file.deletions, 0),
          changedFiles: input.files.length,
        }
      : {}),
  };
  if (input.supersededAt !== null) {
    return {
      ...base,
      state: GitHubPRState.Closed,
      closedAt: new Date(input.supersededAt).toISOString(),
    };
  }
  const settledMs =
    input.openedAt +
    (REVIEW_MIN_HOURS + (input.number % REVIEW_SPREAD_HOURS)) * HOUR_MS;
  if (settledMs > input.nowMs) {
    return { ...base, state: GitHubPRState.Open };
  }
  const settledAt = new Date(settledMs).toISOString();
  if (input.number % 9 === 0) {
    return { ...base, state: GitHubPRState.Closed, closedAt: settledAt };
  }
  return {
    ...base,
    state: GitHubPRState.Merged,
    mergedAt: settledAt,
    closedAt: settledAt,
  };
}

function readEventRows(storePath: string): EventRow[] {
  const db = openSnapshot(storePath);
  try {
    return db
      .prepare(EVENT_SELECT)
      .all()
      .flatMap((raw) => {
        const parsed = eventRowSchema.safeParse(raw);
        return parsed.success ? [parsed.data] : [];
      });
  } finally {
    db.close();
  }
}

function parseToolInput(row: EventRow): unknown {
  if (row.toolInput === null) {
    return null;
  }
  if (row.inputType !== "object") {
    return row.toolInput;
  }
  try {
    return JSON.parse(row.toolInput);
  } catch {
    return null;
  }
}

function shellCommand(input: unknown): string | null {
  const parsed = shellInputSchema.safeParse(input);
  if (!parsed.success) {
    return null;
  }
  if ("cmd" in parsed.data) {
    return parsed.data.cmd;
  }
  const { command } = parsed.data;
  return Array.isArray(command) ? command.join("\n") : command;
}

function commitMessages(command: string): string[] {
  const messages: string[] = [];
  for (const match of command.matchAll(HEREDOC_COMMIT)) {
    messages.push(cleanMessage(match[2] ?? ""));
  }
  for (const match of command.matchAll(INLINE_COMMIT)) {
    messages.push(cleanMessage(match[1] ?? ""));
  }
  return messages.filter((message) => message.length > 0);
}

function cleanMessage(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => !TRAILER_LINE.test(line.trim()))
    .join("\n")
    .trim();
}

function subjectOf(message: string): string {
  return message.split("\n", 1)[0]?.trim() ?? "";
}

function humanizeBranchName(branchName: string): string {
  const leaf = branchName.split("/").at(-1) ?? branchName;
  const ticket = TICKET_TOKEN.exec(leaf)?.[1];
  const words = (ticket ? leaf.replace(ticket, "") : leaf)
    .split("-")
    .filter((word) => word.length > 0)
    .join(" ");
  const sentence = words.charAt(0).toUpperCase() + words.slice(1);
  return ticket ? `${ticket.toUpperCase()}: ${sentence}` : sentence;
}

/** The login a session's machine user pushes as, from its branch prefix or home directory. */
function sessionPerson(cwd: string | null, branchName: string): GitHubPerson {
  const prefix = BRANCH_OWNER_PREFIX.exec(branchName)?.[1];
  if (prefix !== undefined && !COMMON_BRANCH_PREFIXES.has(prefix)) {
    return gitHubPerson(prefix);
  }
  const home = cwd === null ? undefined : HOME_DIRECTORY.exec(cwd)?.[1];
  return gitHubPerson(
    home === undefined
      ? FALLBACK_LOGIN
      : home.replace(NON_LOGIN_CHARACTER, "-").toLowerCase()
  );
}

/** A link recording that its session pushed the branch. */
export function isPushLink(link: StoreLink): boolean {
  return (
    link.kind === ArtifactRefTargetKind.Branch &&
    link.relation === ArtifactRefRelation.Created &&
    BRANCH_PUSH_METHODS.has(link.method)
  );
}

function emptyDraft(
  repositoryFullName: string,
  branchName: string
): BranchDraft {
  return {
    repositoryFullName,
    branchName,
    author: null,
    pushes: [],
    edits: [],
    commits: [],
    pullRequests: [],
  };
}

export function derivedSha(seed: string): string {
  return createHash("sha1").update(seed).digest("hex");
}

/**
 * ISS-12135: a branch whose sessions pushed without one recorded edit (the
 * work happened in a shell or another tool) would show a pull request of
 * +0 -0. It gets one changed file under the branch's name, sized from the
 * branch name so a rerun writes the same change.
 */
function placeholderEdits(
  draft: BranchDraft
): { at: number; edit: FileEdit }[] {
  const at = draft.pushes.at(-1);
  if (at === undefined) {
    return [];
  }
  const seed = createHash("sha256").update(draft.branchName).digest();
  const added = 8 + (seed.readUInt8(0) % 60);
  const removed = 2 + (seed.readUInt8(1) % 12);
  const leaf = (draft.branchName.split("/").at(-1) ?? draft.branchName)
    .replace(NON_LOGIN_CHARACTER, "-")
    .toLowerCase();
  const line = (index: number) => `  step${index + 1}: "${leaf}",`;
  return [
    {
      at,
      edit: {
        path: `apps/web/src/${leaf}.ts`,
        status: FileChangeStatus.Modified,
        removed: Array.from({ length: removed }, (_, index) => line(index)),
        added: Array.from({ length: added }, (_, index) =>
          line(index + removed)
        ),
        contextBefore: [],
        contextAfter: [],
      },
    },
  ];
}
