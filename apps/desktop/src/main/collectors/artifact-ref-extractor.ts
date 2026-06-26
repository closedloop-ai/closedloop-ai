/**
 * @file artifact-ref-extractor.ts
 * @description FEA-1684: Deterministic session-to-artifact reference extractor.
 * Runs at parse/import time on the desktop. Produces structured ref records
 * covering Closedloop artifacts, GitHub PRs, branches, and commits.
 *
 * Single versioned module — all 5 parsers feed NormalizedSession through this.
 * Bumping EXTRACTOR_VERSION triggers re-derivation via backfill.
 */
import { createHash } from "node:crypto";
// FEA-1684: the ref-classification value sets are canonicalized as
// const-object enums in @repo/api (the SSOT shared by cloud + desktop).
// Import the derived value-types here instead of re-declaring the same
// literal unions inline. Per the repo "Never duplicate types" rule in CLAUDE.md.
import type {
  ArtifactRefConfidence,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import {
  FIXTURE_OWNER_RE,
  flattenTextValues,
  GITHUB_PR_URL_RE,
  PR_TOOL_PATTERNS,
} from "./parser-utils.js";
import type { NormalizedSession, NormalizedToolUse } from "./types.js";

// PRD-486: bumped 2 → 3 for the new GIT_COMMIT_SUBJECT_RE regex and the commit
// `message`/`committedAt` fields. The bump makes the backfill re-derive already-
// imported sessions, so their pre-existing commit artifacts get committed_at/title
// filled (otherwise they stay NULL and never render a rail dot). Per AGENTS.md
// §Idempotent Re-Processing, EXTRACTOR_VERSION must bump when a new regex is added.
// Bumped 3 → 4: 'created' PR refs now carry the head branch active at `gh pr
// create` time (NormalizedToolUse.gitBranch), so the backfill re-derives links
// and PR head-ref attribution for already-imported sessions.
// Bumped 4 → 5: multi-harness shell-tool detection — shellCommand() now
// normalizes array-shaped commands (e.g. Codex's ["git","push",...]) so the
// branch/commit/PR regexes run on harnesses that don't pass a bare string. The
// bump re-derives already-imported sessions whose array-shaped git calls were
// previously dropped.
export const EXTRACTOR_VERSION = 5;
export const LAUNCH_METADATA_REF_METHOD = "launch_metadata";

// --- Types ---

export type ArtifactRefRecord = {
  targetKind: ArtifactRefTargetKind;
  targetIdentity: string;
  relation: ArtifactRefRelation;
  method: string;
  evidence: string;
  observedAt: string;
  confidence: ArtifactRefConfidence;
  extractorVersion: number;
  isPrimary: boolean;
  // PR-specific
  repoFullName?: string;
  prNumber?: number;
  prUrl?: string;
  // Branch-specific
  branchName?: string;
  // Commit-specific
  sha?: string;
  /** Commit subject, parsed from the `[branch sha] subject` git output (PRD-486). */
  message?: string;
  /** Commit time — the transcript event time of the `git commit` (NOT scan time). */
  committedAt?: string;
  // Closedloop-specific
  slug?: string;
};

// --- Per-harness capability gaps (documented per AC-13) ---

export const HARNESS_CAPABILITIES = {
  claude: { gitBranch: true, mcpServer: false, mcpMethod: false, slug: true },
  codex: { gitBranch: true, mcpServer: true, mcpMethod: true, slug: false },
  cursor: { gitBranch: true, mcpServer: false, mcpMethod: false, slug: false },
  copilot: {
    gitBranch: false,
    mcpServer: false,
    mcpMethod: false,
    slug: false,
  },
  opencode: {
    gitBranch: false,
    mcpServer: false,
    mcpMethod: false,
    slug: true,
  },
} as const;

// --- Regexes ---

const CLOSEDLOOP_SLUG_RE = /\b(PRD|FEA|PLN|PRO|WRK|SES)-(\d{1,5})\b/g;

// The `[a-zA-Z0-9_-]+` org-slug segment is matched but intentionally
// discarded: slugs are resolved to artifacts scoped to the importing org
// downstream, so the org segment in the URL carries no authority here.
const CLOSEDLOOP_URL_RE =
  /https:\/\/app\.closedloop\.ai\/[a-zA-Z0-9_-]+\/(?:features|plans|implementation-plans|prds|projects)\/((PRD|FEA|PLN|PRO|WRK|SES)-\d{1,5})/g;

const GH_PR_CREATE_REGEX =
  /(?:^|[;&|(\n\t])\s*(?:\S+=\S+\s+)*gh\s+pr\s+create(?:$|[\s'"])/;

const COMMIT_SHA_RE = /\b([0-9a-f]{7,40})\b/g;

const GIT_COMMIT_CMD_RE = /git\s+commit/;

const SHELL_TOOL_NAMES = new Set(["Bash", "shell", "exec_command"]);

// Git commands that reveal the working branch (session.gitBranch is stale —
// set once at session start and never updated when the user creates worktrees,
// checks out branches, or pushes to different remotes mid-session).
const GIT_WORKTREE_ADD_RE =
  /git\s+worktree\s+add\s+(?:"[^"]+"|'[^']+'|\S+)\s+(?:-b\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))/;
const GIT_CHECKOUT_RE =
  /git\s+(?:checkout|switch)\s+(?:-[bBc]\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/;
const GIT_PUSH_BRANCH_RE =
  /git\s+push\s+(?:-[uf]\s+)*(?:origin|upstream)\s+(?:"([^"]+)"|'([^']+)'|([^\s:;&|]+))/;
const GH_PR_CREATE_BRANCH_RE = /gh\s+pr\s+create/;

const FENCE_OPEN_RE = /^(`{3,})/;
const INLINE_CODE_RE = /`[^`]+`/g;
const CLOSEDLOOP_SLUG_ANCHORED_RE = /\b(PRD|FEA|PLN|PRO|WRK|SES)-\d{1,5}\b/;
const CLOSEDLOOP_SLUG_FULL_MATCH_RE = /^(PRD|FEA|PLN|PRO|WRK|SES)-\d{1,5}$/;
const CLOSEDLOOP_SLUG_BRANCH_RE = /\b(PRD|FEA|PLN|PRO|WRK|SES)-\d{1,5}\b/i;
const TRAILING_SLASHES_RE = /\/+$/;
const GH_PR_BRANCH_OUTPUT_RE = /branch\s+'([^']+)'/;
const GIT_COMMIT_BRANCH_RE = /^\[([^\s\]]+)\s+[0-9a-f]/m;
// Captures the commit subject from a `git commit` summary line, e.g.
// "[feat/x 1a2b3c4] Add thing" or "[main (root-commit) 1a2b3c4] Init" → "Add thing".
const GIT_COMMIT_SUBJECT_RE = /^\[[^\]]*\]\s+(.+)$/m;

// --- Code-fence stripping ---

export function stripCodeFences(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inFence = false;
  let fenceMarker = "";

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (inFence) {
      if (
        trimmed.startsWith(fenceMarker) &&
        trimmed.slice(fenceMarker.length).trim() === ""
      ) {
        inFence = false;
        fenceMarker = "";
      }
      // Inside fence — skip line
    } else {
      const fenceMatch = trimmed.match(FENCE_OPEN_RE);
      if (fenceMatch) {
        inFence = true;
        fenceMarker = fenceMatch[1];
        continue;
      }
      result.push(line.replace(INLINE_CODE_RE, ""));
    }
  }
  // If fence never closed, we already skipped everything after the opener (conservative)
  return result.join("\n");
}

// --- Closedloop MCP tool detection ---

function isClosedloopMcpTool(tu: NormalizedToolUse): boolean {
  return (
    tu.name.startsWith("mcp__closedloop__") || tu.mcpServer === "closedloop"
  );
}

function extractMcpToolInputSlugs(input: unknown): string[] {
  if (!input || typeof input !== "object") {
    return [];
  }
  const obj = input as Record<string, unknown>;
  const slugs: string[] = [];
  for (const key of [
    "documentId",
    "slug",
    "projectId",
    "loopId",
    "artifactId",
    "sourceId",
    "targetId",
  ]) {
    const val = obj[key];
    if (typeof val === "string") {
      const m = val.match(CLOSEDLOOP_SLUG_RE);
      CLOSEDLOOP_SLUG_RE.lastIndex = 0;
      if (m) {
        slugs.push(m[0]);
      }
    }
  }
  return slugs;
}

function extractMcpToolOutputSlugs(output: unknown): string[] {
  if (!output) {
    return [];
  }
  const texts = flattenTextValues(output);
  const slugs: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(CLOSEDLOOP_SLUG_RE)) {
      const slug = m[0];
      if (!seen.has(slug)) {
        seen.add(slug);
        slugs.push(slug);
      }
    }
  }
  return slugs;
}

// --- PR extraction helpers ---

function extractPrUrlsFromTexts(
  texts: string[]
): Array<{ url: string; repo: string; number: number }> {
  const refs: Array<{ url: string; repo: string; number: number }> = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(GITHUB_PR_URL_RE)) {
      const owner = match[1];
      const repo = match[2];
      const num = match[3];
      if (!(owner && repo && num) || FIXTURE_OWNER_RE.test(owner)) {
        continue;
      }
      const url = `https://github.com/${owner}/${repo}/pull/${num}`;
      if (seen.has(url)) {
        continue;
      }
      seen.add(url);
      refs.push({
        url,
        repo: `${owner}/${repo}`,
        number: Number.parseInt(num, 10),
      });
    }
  }
  return refs;
}

function shellCommand(tu: NormalizedToolUse): string {
  const inp = tu.input as Record<string, unknown> | string | undefined;
  if (!inp) {
    return "";
  }
  if (typeof inp === "string") {
    return inp;
  }
  // Codex normalizes shell calls as arrays, e.g. ["git", "push", "-u", "origin", "feat/x"].
  if (Array.isArray(inp)) {
    return inp.join(" ");
  }
  if (typeof inp.command === "string") {
    return inp.command;
  }
  if (Array.isArray(inp.command)) {
    return inp.command.join(" ");
  }
  if (typeof inp.cmd === "string") {
    return inp.cmd;
  }
  if (Array.isArray(inp.cmd)) {
    return inp.cmd.join(" ");
  }
  return "";
}

// Shared shell/git-command guard used by the commit and branch passes: returns
// the normalized command string for a shell-family tool use (possibly empty),
// or null for non-shell tools. Callers skip a tool use when this is null.
function shellCommandIfShellTool(tu: NormalizedToolUse): string | null {
  return SHELL_TOOL_NAMES.has(tu.name) ? shellCommand(tu) : null;
}

function isPrCreateCommand(tu: NormalizedToolUse): boolean {
  if (SHELL_TOOL_NAMES.has(tu.name)) {
    return GH_PR_CREATE_REGEX.test(shellCommand(tu));
  }
  return PR_TOOL_PATTERNS.has(tu.name);
}

// --- Main extractor: a registry of named single-responsibility passes ---
//
// Each pass takes (session, ctx) and pushes records onto the shared
// `ctx.refs` accumulator using the single `ctx.observedAt` timestamp. The
// extractor runs them in order, then deduplicates and selects the primary.
// Splitting the former 7-branch monolith into named passes keeps each one
// individually simple and independently testable; ORDER IS PRESERVED so the
// dedup confidence-ranking and primary-method precedence behave identically.

type ExtractContext = {
  /** Single observation timestamp shared by every record in one run. */
  readonly observedAt: string;
  /** Shared accumulator every pass appends to. */
  readonly refs: ArtifactRefRecord[];
};

type ExtractorPass = {
  readonly name: string;
  readonly run: (session: NormalizedSession, ctx: ExtractContext) => void;
};

// --- 1. Closedloop MCP tool-call refs (highest confidence) ---
function extractMcpToolCallRefs(
  session: NormalizedSession,
  ctx: ExtractContext
): void {
  for (let i = 0; i < session.toolUses.length; i++) {
    const tu = session.toolUses[i];
    if (!isClosedloopMcpTool(tu)) {
      continue;
    }

    const inputSlugs = extractMcpToolInputSlugs(tu.input);
    for (const slug of inputSlugs) {
      ctx.refs.push({
        targetKind: "closedloop_artifact",
        targetIdentity: slug,
        slug,
        relation: "input",
        method: "mcp_tool_call",
        confidence: "mcp_call",
        evidence: JSON.stringify({
          toolIndex: i,
          toolName: tu.name,
          field: "input",
        }),
        observedAt: ctx.observedAt,
        extractorVersion: EXTRACTOR_VERSION,
        isPrimary: false,
      });
    }

    const outputSlugs = extractMcpToolOutputSlugs(tu.output);
    for (const slug of outputSlugs) {
      if (inputSlugs.includes(slug)) {
        continue;
      }
      ctx.refs.push({
        targetKind: "closedloop_artifact",
        targetIdentity: slug,
        slug,
        relation: "output",
        method: "mcp_tool_call",
        confidence: "mcp_call",
        evidence: JSON.stringify({
          toolIndex: i,
          toolName: tu.name,
          field: "output",
        }),
        observedAt: ctx.observedAt,
        extractorVersion: EXTRACTOR_VERSION,
        isPrimary: false,
      });
    }
  }
}

// --- 2. Closedloop URL refs (tool input AND output, plus message text) ---
// Push a Closedloop-artifact ref for every app.closedloop.ai URL in one text.
function pushClosedloopUrlRefs(
  ctx: ExtractContext,
  text: string,
  relation: ArtifactRefRelation,
  evidence: Record<string, unknown>
): void {
  for (const m of text.matchAll(CLOSEDLOOP_URL_RE)) {
    ctx.refs.push({
      targetKind: "closedloop_artifact",
      targetIdentity: m[1],
      slug: m[1],
      relation,
      method: "url_in_message",
      confidence: "url_match",
      evidence: JSON.stringify(evidence),
      observedAt: ctx.observedAt,
      extractorVersion: EXTRACTOR_VERSION,
      isPrimary: false,
    });
  }
}

function extractClosedloopUrlRefs(
  session: NormalizedSession,
  ctx: ExtractContext
): void {
  for (let i = 0; i < session.toolUses.length; i++) {
    const tu = session.toolUses[i];
    for (const text of flattenTextValues(tu.input)) {
      pushClosedloopUrlRefs(ctx, text, "input", {
        toolIndex: i,
        source: "tool_input",
      });
    }
    for (const text of flattenTextValues(tu.output)) {
      pushClosedloopUrlRefs(ctx, text, "output", {
        toolIndex: i,
        source: "tool_output",
      });
    }
  }

  // Closedloop URLs in message text (both human and assistant)
  for (let i = 0; i < session.messages.length; i++) {
    const msg = session.messages[i];
    if (!msg.text) {
      continue;
    }
    pushClosedloopUrlRefs(ctx, msg.text, "input", {
      messageIndex: i,
      role: msg.role,
    });
  }
}

// --- 3. Bare slug extraction (message text + tool INPUT only, after code-fence stripping) ---
function extractBareSlugRefs(
  session: NormalizedSession,
  ctx: ExtractContext
): void {
  for (let i = 0; i < session.messages.length; i++) {
    const msg = session.messages[i];
    if (!msg.text) {
      continue;
    }
    const stripped = stripCodeFences(msg.text);
    for (const m of stripped.matchAll(CLOSEDLOOP_SLUG_RE)) {
      ctx.refs.push({
        targetKind: "closedloop_artifact",
        targetIdentity: m[0],
        slug: m[0],
        relation: "input",
        method: "slug_in_message",
        confidence: "slug_match_in_prose",
        evidence: JSON.stringify({ messageIndex: i, role: msg.role }),
        observedAt: ctx.observedAt,
        extractorVersion: EXTRACTOR_VERSION,
        isPrimary: false,
      });
    }
  }

  for (let i = 0; i < session.toolUses.length; i++) {
    const tu = session.toolUses[i];
    const inputTexts = flattenTextValues(tu.input);
    for (const text of inputTexts) {
      const stripped = stripCodeFences(text);
      for (const m of stripped.matchAll(CLOSEDLOOP_SLUG_RE)) {
        ctx.refs.push({
          targetKind: "closedloop_artifact",
          targetIdentity: m[0],
          slug: m[0],
          relation: "input",
          method: "slug_in_message",
          confidence: "slug_match_in_prose",
          evidence: JSON.stringify({ toolIndex: i, source: "tool_input" }),
          observedAt: ctx.observedAt,
          extractorVersion: EXTRACTOR_VERSION,
          isPrimary: false,
        });
      }
    }
  }
}

// --- 4. PR refs with created-vs-referenced distinction ---
function extractPullRequestRefs(
  session: NormalizedSession,
  ctx: ExtractContext
): void {
  for (let i = 0; i < session.toolUses.length; i++) {
    const tu = session.toolUses[i];
    const inputTexts = flattenTextValues(tu.input);
    const outputTexts = flattenTextValues(tu.output);
    const inputUrls = new Set(
      extractPrUrlsFromTexts(inputTexts).map((r) => r.url)
    );
    const outputPrs = extractPrUrlsFromTexts(outputTexts);
    const allPrs = extractPrUrlsFromTexts([...inputTexts, ...outputTexts]);

    for (const pr of allPrs) {
      const isCreateTool = isPrCreateCommand(tu);
      const inOutput = outputPrs.some((p) => p.url === pr.url);
      const inInput = inputUrls.has(pr.url);

      let relation: "created" | "referenced";
      if (isCreateTool && inOutput && !inInput) {
        relation = "created";
      } else {
        relation = "referenced";
      }

      // For a CREATED PR the head ref is knowable for certain: the branch the
      // user was on WHEN `gh pr create` ran (recorded per-line). Prefer that over
      // the session's stale start branch. A referenced PR is someone else's work,
      // so it carries no head ref (left undefined → null downstream).
      const headBranch =
        relation === "created"
          ? (tu.gitBranch ?? session.gitBranch ?? undefined)
          : undefined;

      ctx.refs.push({
        targetKind: "pull_request",
        targetIdentity: `${pr.repo}#${pr.number}`,
        relation,
        method:
          relation === "created" ? "pr_create_output" : "pr_url_in_tool_use",
        confidence: "url_match",
        evidence: JSON.stringify({
          toolIndex: i,
          toolName: tu.name,
          prUrl: pr.url,
        }),
        observedAt: ctx.observedAt,
        extractorVersion: EXTRACTOR_VERSION,
        isPrimary: false,
        repoFullName: pr.repo,
        prNumber: pr.number,
        prUrl: pr.url,
        branchName: headBranch,
      });
    }
  }
}

// --- 5. Workspace context: gitBranch, cwd, session slug ---
function extractWorkspaceContextRefs(
  session: NormalizedSession,
  ctx: ExtractContext
): void {
  if (session.gitBranch) {
    const branchSlugMatch = session.gitBranch.match(
      CLOSEDLOOP_SLUG_ANCHORED_RE
    );
    if (branchSlugMatch) {
      ctx.refs.push({
        targetKind: "closedloop_artifact",
        targetIdentity: branchSlugMatch[0],
        slug: branchSlugMatch[0],
        relation: "workspace",
        method: "slug_in_branch",
        confidence: "slug_match_in_branch",
        evidence: JSON.stringify({ gitBranch: session.gitBranch }),
        observedAt: ctx.observedAt,
        extractorVersion: EXTRACTOR_VERSION,
        isPrimary: false,
      });
    }
    ctx.refs.push({
      targetKind: "branch",
      targetIdentity: session.gitBranch,
      branchName: session.gitBranch,
      relation: "workspace",
      method: "slug_in_branch",
      confidence: "slug_match_in_branch",
      evidence: JSON.stringify({ gitBranch: session.gitBranch }),
      observedAt: ctx.observedAt,
      extractorVersion: EXTRACTOR_VERSION,
      isPrimary: false,
      repoFullName: session.artifacts.repo ?? undefined,
    });
  }

  if (session.cwd) {
    const lastComponent =
      session.cwd.replace(TRAILING_SLASHES_RE, "").split("/").at(-1) ?? "";
    const cwdSlugMatch = lastComponent.match(CLOSEDLOOP_SLUG_ANCHORED_RE);
    if (cwdSlugMatch) {
      ctx.refs.push({
        targetKind: "closedloop_artifact",
        targetIdentity: cwdSlugMatch[0],
        slug: cwdSlugMatch[0],
        relation: "workspace",
        method: "slug_in_cwd",
        confidence: "slug_match_in_branch",
        evidence: JSON.stringify({ cwd: session.cwd }),
        observedAt: ctx.observedAt,
        extractorVersion: EXTRACTOR_VERSION,
        isPrimary: false,
      });
    }
  }

  if (session.slug) {
    const sessionSlugMatch = session.slug.match(CLOSEDLOOP_SLUG_FULL_MATCH_RE);
    if (sessionSlugMatch) {
      ctx.refs.push({
        targetKind: "closedloop_artifact",
        targetIdentity: session.slug,
        slug: session.slug,
        relation: "workspace",
        method: "slug_in_session_slug",
        confidence: "slug_match_in_branch",
        evidence: JSON.stringify({ sessionSlug: session.slug }),
        observedAt: ctx.observedAt,
        extractorVersion: EXTRACTOR_VERSION,
        isPrimary: false,
      });
    }
  }
}

// --- 6. Commit refs (conservative: only after git commit commands) ---
function extractCommitRefs(
  session: NormalizedSession,
  ctx: ExtractContext
): void {
  for (let i = 0; i < session.toolUses.length; i++) {
    const tu = session.toolUses[i];
    const cmd = shellCommandIfShellTool(tu);
    if (cmd === null || !GIT_COMMIT_CMD_RE.test(cmd) || !tu.output) {
      continue;
    }

    const outputTexts = flattenTextValues(tu.output);
    // PRD-486: capture the commit subject + real commit time at the moment the
    // `git commit` ran, so the branch rail can show a dot per commit without
    // reconstructing history. The subject is the `[branch sha] subject` summary
    // line; the time is the transcript event time of THIS tool call — NOT
    // `observedAt`, which is wall-clock import/scan time (the FEA-2022 trap).
    let commitSubject: string | undefined;
    for (const text of outputTexts) {
      const subjectMatch = text.match(GIT_COMMIT_SUBJECT_RE);
      if (subjectMatch?.[1]) {
        commitSubject = subjectMatch[1].trim();
        break;
      }
    }
    // No transcript timestamp → leave committedAt unset (do NOT fall back to
    // observedAt/scan time). A scan-time value would pass the `committed_at IS
    // NOT NULL` read filter and reintroduce the FEA-2022 regression; the SHA-only
    // commit row is instead simply skipped by the rail (no dot, no activity bump).
    const committedAt = tu.timestamp ?? undefined;
    for (const text of outputTexts) {
      for (const m of text.matchAll(COMMIT_SHA_RE)) {
        if (m[1].length < 7) {
          continue;
        }
        ctx.refs.push({
          targetKind: "commit",
          targetIdentity: m[1],
          sha: m[1],
          relation: "created",
          method: "git_command",
          confidence: "slug_match_in_prose",
          evidence: JSON.stringify({
            toolIndex: i,
            command: cmd.slice(0, 100),
          }),
          observedAt: ctx.observedAt,
          committedAt,
          message: commitSubject,
          extractorVersion: EXTRACTOR_VERSION,
          isPrimary: false,
          repoFullName: session.artifacts.repo ?? undefined,
        });
      }
    }
  }
}

// --- 7. Branch detection from git commands ---
// session.gitBranch is captured once at session start and never updates.
// Scan shell tool inputs for git commands that reveal actual working branches.
// Attribute to ALL detected branches (don't pick a winner).

type DetectedBranch = { branch: string; method: string };

// Branch-revealing commands whose branch is named in the command itself, as
// regex capture group 1 ?? 2 ?? 3 (the quoted/unquoted-name alternatives).
const BRANCH_COMMAND_PATTERNS: ReadonlyArray<{
  re: RegExp;
  method: string;
  reject?: (branch: string) => boolean;
}> = [
  // git worktree add <path> [-b] <branch>
  { re: GIT_WORKTREE_ADD_RE, method: "git_worktree_add" },
  // git checkout/switch [-b] <branch>
  { re: GIT_CHECKOUT_RE, method: "git_checkout", reject: (b) => b === "." },
  // git push [-u] origin <branch>
  { re: GIT_PUSH_BRANCH_RE, method: "git_push" },
];

function detectBranchesInCommand(cmd: string): DetectedBranch[] {
  const detected: DetectedBranch[] = [];
  for (const { re, method, reject } of BRANCH_COMMAND_PATTERNS) {
    const match = cmd.match(re);
    if (!match) {
      continue;
    }
    const branch = match[1] ?? match[2] ?? match[3];
    if (branch && !branch.startsWith("-") && !reject?.(branch)) {
      detected.push({ branch, method });
    }
  }
  return detected;
}

// Branches echoed in command OUTPUT. The PR URL is already captured in pass 4,
// but the output often also names the branch.
function detectBranchesInOutput(
  cmd: string,
  tu: NormalizedToolUse
): DetectedBranch[] {
  if (!tu.output) {
    return [];
  }
  const detected: DetectedBranch[] = [];
  const outputTexts = flattenTextValues(tu.output);

  // gh pr create output often includes "branch 'feat/xxx'" or similar.
  if (GH_PR_CREATE_BRANCH_RE.test(cmd)) {
    for (const text of outputTexts) {
      const match = text.match(GH_PR_BRANCH_OUTPUT_RE);
      if (match?.[1]) {
        detected.push({ branch: match[1], method: "gh_pr_create" });
      }
    }
  }

  // git commit summary line, e.g. "[feat/fea-1684 abc1234] message".
  if (GIT_COMMIT_CMD_RE.test(cmd)) {
    for (const text of outputTexts) {
      const match = text.match(GIT_COMMIT_BRANCH_RE);
      if (match?.[1]) {
        detected.push({ branch: match[1], method: "git_commit" });
      }
    }
  }
  return detected;
}

// Push a branch ref for each detected branch, plus any Closedloop slug embedded
// in the branch name (case-insensitive: branch names like feat/fea-1684).
function pushBranchRefs(
  ctx: ExtractContext,
  session: NormalizedSession,
  toolIndex: number,
  cmd: string,
  detected: DetectedBranch[]
): void {
  for (const { branch, method } of detected) {
    ctx.refs.push({
      targetKind: "branch",
      targetIdentity: branch,
      branchName: branch,
      relation: "workspace",
      method,
      confidence: "url_match",
      evidence: JSON.stringify({ toolIndex, command: cmd.slice(0, 200) }),
      observedAt: ctx.observedAt,
      extractorVersion: EXTRACTOR_VERSION,
      isPrimary: false,
      repoFullName: session.artifacts.repo ?? undefined,
    });

    const slugMatch = branch.match(CLOSEDLOOP_SLUG_BRANCH_RE);
    if (slugMatch) {
      const normalizedSlug = slugMatch[0].toUpperCase();
      ctx.refs.push({
        targetKind: "closedloop_artifact",
        targetIdentity: normalizedSlug,
        slug: normalizedSlug,
        relation: "workspace",
        method: "slug_in_branch",
        confidence: "slug_match_in_branch",
        evidence: JSON.stringify({
          detectedBranch: branch,
          via: method,
          toolIndex,
        }),
        observedAt: ctx.observedAt,
        extractorVersion: EXTRACTOR_VERSION,
        isPrimary: false,
      });
    }
  }
}

function extractBranchRefs(
  session: NormalizedSession,
  ctx: ExtractContext
): void {
  for (let i = 0; i < session.toolUses.length; i++) {
    const tu = session.toolUses[i];
    const cmd = shellCommandIfShellTool(tu);
    if (!cmd) {
      continue;
    }
    // Order matters: command-named branches first, then output-echoed ones —
    // this preserves the original push order for downstream dedup precedence.
    const detected = [
      ...detectBranchesInCommand(cmd),
      ...detectBranchesInOutput(cmd, tu),
    ];
    pushBranchRefs(ctx, session, i, cmd, detected);
  }
}

// Pass registry — runs in declared order; the order is load-bearing for the
// downstream dedup confidence-ranking and primary-method precedence.
const EXTRACTOR_PASSES: readonly ExtractorPass[] = [
  { name: "mcp_tool_call", run: extractMcpToolCallRefs },
  { name: "closedloop_url", run: extractClosedloopUrlRefs },
  { name: "bare_slug", run: extractBareSlugRefs },
  { name: "pull_request", run: extractPullRequestRefs },
  { name: "workspace_context", run: extractWorkspaceContextRefs },
  { name: "commit", run: extractCommitRefs },
  { name: "branch", run: extractBranchRefs },
];

export function extractArtifactRefs(
  session: NormalizedSession,
  now?: string
): ArtifactRefRecord[] {
  const ctx: ExtractContext = {
    observedAt: now ?? new Date().toISOString(),
    refs: [],
  };

  for (const pass of EXTRACTOR_PASSES) {
    pass.run(session, ctx);
  }

  // --- Deduplicate and select primary ---
  const deduped = deduplicateRefs(ctx.refs);
  return selectPrimary(deduped);
}

// --- Launch-metadata extraction (called separately with cwd) ---

export function extractLaunchMetadataRefs(
  launchMetadata: { sourceArtifactId?: string } | null,
  observedAt?: string
): ArtifactRefRecord[] {
  if (!launchMetadata?.sourceArtifactId) {
    return [];
  }
  const slug = launchMetadata.sourceArtifactId;
  if (!CLOSEDLOOP_SLUG_FULL_MATCH_RE.test(slug)) {
    return [];
  }

  return [
    {
      targetKind: "closedloop_artifact",
      targetIdentity: slug,
      slug,
      relation: "input",
      method: LAUNCH_METADATA_REF_METHOD,
      confidence: "mcp_call",
      evidence: JSON.stringify({ source: "launch-metadata.json" }),
      observedAt: observedAt ?? new Date().toISOString(),
      extractorVersion: EXTRACTOR_VERSION,
      isPrimary: false,
    },
  ];
}

// --- Deduplication ---

const CONFIDENCE_RANK: Record<string, number> = {
  mcp_call: 4,
  url_match: 3,
  slug_match_in_prose: 2,
  slug_match_in_branch: 1,
};

function deduplicateRefs(refs: ArtifactRefRecord[]): ArtifactRefRecord[] {
  const map = new Map<string, ArtifactRefRecord>();
  for (const ref of refs) {
    const key = `${ref.targetKind}|${ref.targetIdentity}|${ref.relation}`;
    const existing = map.get(key);
    if (
      !existing ||
      (CONFIDENCE_RANK[ref.confidence] ?? 0) >
        (CONFIDENCE_RANK[existing.confidence] ?? 0)
    ) {
      map.set(key, ref);
    }
  }
  return [...map.values()];
}

// --- Primary selection ---

const PRIMARY_METHOD_PRECEDENCE: string[] = [
  "mcp_tool_call",
  "url_in_message",
  "slug_in_cwd",
  LAUNCH_METADATA_REF_METHOD,
  "slug_in_branch",
  "slug_in_session_slug",
  "slug_in_message",
];

function selectPrimary(refs: ArtifactRefRecord[]): ArtifactRefRecord[] {
  const clRefs = refs.filter((r) => r.targetKind === "closedloop_artifact");
  if (clRefs.length === 0) {
    return refs;
  }

  let bestMethod = -1;
  let bestRef: ArtifactRefRecord | null = null;
  let ambiguous = false;

  for (const ref of clRefs) {
    const rank = PRIMARY_METHOD_PRECEDENCE.indexOf(ref.method);
    if (rank === -1) {
      continue;
    }
    if (rank < bestMethod || bestMethod === -1) {
      bestMethod = rank;
      bestRef = ref;
      ambiguous = false;
    } else if (
      rank === bestMethod &&
      bestRef &&
      ref.targetIdentity !== bestRef.targetIdentity
    ) {
      ambiguous = true;
    }
  }

  if (bestRef && !ambiguous) {
    bestRef.isPrimary = true;
  }

  return refs;
}

// --- Canonical key for dedup/hashing ---

export function canonicalKeyForRef(ref: ArtifactRefRecord): string {
  switch (ref.targetKind) {
    case "pull_request":
      return `${ref.repoFullName}#${ref.prNumber}`;
    case "branch":
      return `${ref.repoFullName ?? ""}:${ref.branchName}`;
    case "commit":
      return ref.sha ?? ref.targetIdentity;
    default:
      return ref.slug ?? ref.targetIdentity;
  }
}

// --- Deterministic hash ID for SQLite rows ---

export function artifactLinkId(
  sessionId: string,
  targetKind: string,
  canonicalNaturalKey: string,
  relation: string
): string {
  return createHash("sha256")
    .update(`${sessionId}|${targetKind}|${canonicalNaturalKey}|${relation}`)
    .digest("hex")
    .slice(0, 16);
}
