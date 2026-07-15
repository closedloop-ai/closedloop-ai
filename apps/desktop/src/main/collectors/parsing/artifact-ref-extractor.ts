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
  BRANCH_PUSH_METHOD_VALUES,
  BRANCH_WRITE_METHOD_VALUES,
} from "../../database/db-constants.js";
import { isValidBranchName } from "../../enrichment/branch-validation.js";
import { isDefaultBranchName } from "../../enrichment/default-branch-names.js";
import type { NormalizedSession, NormalizedToolUse } from "../types.js";
import {
  FIXTURE_OWNER_RE,
  flattenTextValues,
  GITHUB_PR_URL_RE,
  PR_TOOL_PATTERNS,
  shellCommand,
  shellCommandArgv,
} from "./parser-utils.js";

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
// Bumped 5 → 6: created PR head-branch attribution now rejects default branches
// (main/master/develop/HEAD) from tu.gitBranch — worktree sessions report the
// session CWD branch, not the worktree branch, so a PR created from a worktree
// on feat/x while the session is on main would mis-attribute to main.
// Bumped 6 → 7 (FEA-2531): branch refs now split by evidence — write methods
// (git_push/gh_pr_create/git_commit) emit `relation: "created"`, read methods
// (git_checkout/git_worktree_add) and the session start branch stay `workspace`;
// a failed push (tu.isError) emits no branch ref — see the 9 → 10 bump below,
// which extends this from git_push to every push method; branch refs stamp their
// own event time (tu.timestamp) instead of scan time; the start-branch ref's
// method is renamed to "start_branch". The bump re-derives already-imported
// sessions so their branch links carry the new relation/method/time.
// Bumped 7 → 8 (FEA-2531 hardening): (a) shell-quote-aware git detection —
// the branch/commit/push regexes no longer match git text embedded inside
// ANOTHER command's quoted argument (rg patterns, inline `-e` scripts), the
// source of phantom pushed branches like `feat/x','git`; (b) tightened
// isValidBranchName rejects quote/comma/shell-metacharacter debris;
// (c) created-PR head refs resolve from the session's own write evidence
// (gh pr create output/--head flag, else the nearest preceding branch write)
// BEFORE falling back to per-line tu.gitBranch, which is CWD-derived and
// wrong for every worktree session. The bump re-derives history: poisoned
// branch links drop on delete-then-reinsert, and worktree-created PRs heal
// their pull_requests.branch_name via the import-authoritative upsert.
// Bumped 8 → 9: v8 resolved created-PR head branches during backfill but the
// backfill persists only link rows + push markers — the resolved head ref
// never reached pull_requests.branch_name for already-imported sessions, so
// historical worktree PRs stayed unlinked on the Branches page.
// persistArtifactLinks now fill-only writes the re-derived head branch to the
// created session's pull_requests row; the bump re-runs the backfill so the
// fill lands everywhere.
// Bumped 9 → 10 (FEA-2789): the FEA-2531 failed-push gate now covers every push
// method, not just git_push — a failed `gh pr create` (tu.isError) mints no
// branch ref and is no created-PR head evidence, exactly as a failed `git push`.
// The bump re-derives already-imported sessions so phantom "created"/pushed
// branches minted by past failed `gh pr create` calls drop on the backfill's
// delete-and-rederive (and their first_pushed_at push markers clear with them).
// Bumped 10 → 11 (FEA-2791): the FEA-2531 shell-quote-aware git detection now
// covers argv-shaped commands too — a bundled non-first argv element with
// internal whitespace (Codex's `["rg", "git push origin feat/x"]`) is treated as
// a quoted argument, so command text inside one arg no longer matches the push
// (or unanchored commit) regex and mints a phantom `feat/x` branch or phantom
// commit refs from echoed SHAs. The bump re-derives already-imported sessions so
// such phantom branch/commit links (and push markers) drop on the backfill's
// delete-and-rederive.
export const EXTRACTOR_VERSION = 11;
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
  /git\s+push\s+(?:(?:-[a-zA-Z]+|--[\w-]+(?:=\S+)?)\s+)*(?:origin|upstream)\s+(?:"([^"]+)"|'([^']+)'|([^\s:;&|]+))/;
const GIT_PUSH_CMD_RE = /git\s+push\b/;
// Branch deletion pushes nothing to attribute — never push evidence.
const GIT_PUSH_DELETE_RE = /\s(?:-d|--delete)\b/;
// Success output names the remote ref: "abc123..def456  feat/x -> feat/x",
// "* [new branch]  feat/x -> feat/x", or with -u "branch 'feat/x' set up to
// track ...". Resolves HEAD/long-flag pushes the command regex can't name.
const GIT_PUSH_OUTPUT_REF_RE =
  /^\s*[+*!=]?\s*(?:\[[^\]]+\]|\S+\.{2,3}\S+)\s+(\S+)\s+->\s+(\S+)/m;
const GIT_PUSH_UPSTREAM_OUTPUT_RE =
  /branch\s+'([^']+)'\s+set\s+up\s+to\s+track/;
const GH_PR_CREATE_BRANCH_RE = /gh\s+pr\s+create/;
// gh pr create success output (stderr): "Creating pull request for feat/x
// into main in owner/repo" — the head ref straight from gh itself, the
// strongest created-PR head-branch evidence (FEA-2531).
const GH_PR_CREATE_HEAD_OUTPUT_RE = /Creating pull request for (\S+) into \S+/;
// gh pr create --head/-H flag names the head branch in the command itself.
const GH_PR_HEAD_FLAG_RE =
  /(?:^|\s)(?:--head|-H)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/g;
// Global clones of the branch-command patterns for position-checked scanning:
// a non-global .match() only ever sees the FIRST occurrence, which may sit
// inside a quoted argument while a real git command follows later.
const GIT_WORKTREE_ADD_ALL_RE = new RegExp(GIT_WORKTREE_ADD_RE.source, "g");
const GIT_CHECKOUT_ALL_RE = new RegExp(GIT_CHECKOUT_RE.source, "g");
const GIT_PUSH_BRANCH_ALL_RE = new RegExp(GIT_PUSH_BRANCH_RE.source, "g");

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

// --- Shell-quote awareness (FEA-2531 hardening) ---
//
// The branch/commit/push regexes historically matched git-command text
// ANYWHERE in a shell command — including inside a quoted argument of a
// DIFFERENT command (`rg "…git push origin feat|…"`, `tsx -e "…'git push
// origin feat/x','git…'"`). Those matches minted phantom branches with real
// push evidence. Captures are now position-checked against the command's
// quoted spans; boolean command-shape gates run against a quote-stripped
// copy. Command-boundary anchoring was rejected instead: wrappers like
// `rtk git push …` (a Bash-hook rewrite present in real transcripts) sit
// before the git token, so an anchor would drop genuine evidence.

type QuotedSpan = { start: number; end: number };

/**
 * Spans of `cmd` inside single-/double-quoted shell strings, inclusive of the
 * quote marks; `end` is exclusive. Two-state scanner: backslash escapes are
 * honored outside quotes and inside double quotes (POSIX-ish); single-quoted
 * content is literal until the closing quote. An unterminated quote extends
 * to end-of-string (conservative: everything after it is treated as quoted).
 */
function findQuotedSpans(cmd: string): QuotedSpan[] {
  const spans: QuotedSpan[] = [];
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch !== "'" && ch !== '"') {
      i += 1;
      continue;
    }
    const start = i;
    i += 1;
    while (i < cmd.length && cmd[i] !== ch) {
      i += ch === '"' && cmd[i] === "\\" ? 2 : 1;
    }
    i = i < cmd.length ? i + 1 : cmd.length;
    spans.push({ start, end: i });
  }
  return spans;
}

function isInsideQuotedSpan(spans: QuotedSpan[], index: number): boolean {
  return spans.some((s) => index >= s.start && index < s.end);
}

/**
 * `cmd` with quoted-span CONTENT blanked to spaces (quote marks kept, length
 * preserved) so command-shape gates like GIT_PUSH_CMD_RE cannot fire on text
 * embedded inside another command's argument.
 */
function stripQuotedContent(cmd: string, spans: QuotedSpan[]): string {
  if (spans.length === 0) {
    return cmd;
  }
  const chars = cmd.split("");
  for (const span of spans) {
    const hasClosingQuote =
      span.end - span.start >= 2 && cmd[span.end - 1] === cmd[span.start];
    const contentEnd = hasClosingQuote ? span.end - 1 : span.end;
    for (let j = span.start + 1; j < contentEnd; j++) {
      chars[j] = " ";
    }
  }
  return chars.join("");
}

/**
 * Quoted spans for a shell tool use: real shell quotes (findQuotedSpans) PLUS,
 * for argv-shaped input (Codex `exec_command`), each non-first argv element that
 * itself contains whitespace. `shellCommand`'s `join(" ")` erases argument
 * boundaries, so a bundled element like `"git push origin feat/x"` in
 * `["rg", "git push origin feat/x"]` reads as bare command structure and would
 * mint a phantom `feat/x` branch — the exact case the string form
 * (`rg "git push origin feat/x"`) rejects because the argument is quoted. Marking
 * such an element quoted neutralizes it identically. A spaceless element
 * (`["git","push","origin","feat/x"]`) is a plain token and stays visible, so
 * genuine argv git pushes are still detected (FEA-2791). The span begins at the
 * join separator preceding the element so `stripQuotedContent` — which preserves
 * a span's boundary chars as if they were quote marks — blanks the whole element.
 */
function shellQuotedSpans(tu: NormalizedToolUse, cmd: string): QuotedSpan[] {
  const spans = findQuotedSpans(cmd);
  const argv = shellCommandArgv(tu);
  if (!argv) {
    return spans;
  }
  let offset = 0;
  for (let k = 0; k < argv.length; k++) {
    const element = argv[k];
    if (k > 0 && ARGV_WHITESPACE_RE.test(element)) {
      spans.push({ start: offset - 1, end: offset + element.length });
    }
    offset += element.length + 1; // element + the join separator
  }
  return spans;
}

/** Whitespace inside a single argv element — its presence marks a bundled arg. */
const ARGV_WHITESPACE_RE = /\s/;

/** First match of global `re` whose match START sits outside every quoted span. */
function matchOutsideQuotes(
  cmd: string,
  re: RegExp,
  spans: QuotedSpan[]
): RegExpMatchArray | null {
  for (const m of cmd.matchAll(re)) {
    if (m.index !== undefined && !isInsideQuotedSpan(spans, m.index)) {
      return m;
    }
  }
  return null;
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

// Shared shell/git-command guard used by the commit and branch passes: returns
// the normalized command string for a shell-family tool use (possibly empty),
// or null for non-shell tools. Callers skip a tool use when this is null.
function shellCommandIfShellTool(tu: NormalizedToolUse): string | null {
  return SHELL_TOOL_NAMES.has(tu.name) ? shellCommand(tu) : null;
}

function isPrCreateCommand(tu: NormalizedToolUse): boolean {
  if (SHELL_TOOL_NAMES.has(tu.name)) {
    // Quote-stripped so `echo "… gh pr create …"` and friends don't classify
    // a merely-quoted mention as the create command (FEA-2531 hardening).
    const cmd = shellCommand(tu);
    return GH_PR_CREATE_REGEX.test(
      stripQuotedContent(cmd, findQuotedSpans(cmd))
    );
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

type BranchWriteEvent = { toolIndex: number; branch: string };

// Branch WRITE evidence per tool use — the same quote-aware detections the
// branch pass (7) stores as links, reused so a created PR's head ref resolves
// from the session's own write relationships (FEA-2531) instead of the
// harness-reported CWD branch. Only write methods qualify, and a failed push
// is excluded exactly as in pushBranchRefs.
function collectBranchWriteEvents(
  session: NormalizedSession
): BranchWriteEvent[] {
  const events: BranchWriteEvent[] = [];
  for (let i = 0; i < session.toolUses.length; i++) {
    const tu = session.toolUses[i];
    const cmd = shellCommandIfShellTool(tu);
    if (!cmd) {
      continue;
    }
    const spans = shellQuotedSpans(tu, cmd);
    const strippedCmd = stripQuotedContent(cmd, spans);
    const detected = [
      ...detectBranchesInCommand(cmd, spans, strippedCmd),
      ...detectBranchesInOutput(strippedCmd, tu),
    ];
    for (const { branch, method } of detected) {
      if (!BRANCH_WRITE_METHODS.has(method)) {
        continue;
      }
      if (BRANCH_PUSH_METHODS.has(method) && tu.isError === true) {
        continue;
      }
      if (!isValidBranchName(branch) || isDefaultBranchName(branch)) {
        continue;
      }
      events.push({ toolIndex: i, branch });
    }
  }
  return events;
}

// A CREATED PR's head ref resolves evidence-first (FEA-2531 — the
// relationship model, never the stale CWD branch when better exists):
//   1. write evidence AT the create tool-use itself — gh's own "Creating
//      pull request for <head> into <base>" output line, the --head flag,
//      or a push chained in the same command;
//   2. the nearest PRECEDING branch write in this session (the branch was
//      pushed moments before the PR was raised), gated to the PR's own repo;
//   3. per-line tu.gitBranch LAST — it reports the session CWD's checkout,
//      which is wrong for every worktree flow (FEA-2260 rejects default
//      branches so a worktree session yields null here rather than main).
// A referenced PR is someone else's work and never resolves a head ref.
function resolveCreatedPrHeadBranch(
  tu: NormalizedToolUse,
  toolIndex: number,
  prRepo: string,
  sessionRepo: string | null,
  writeEvents: BranchWriteEvent[]
): { branch: string; via: string } | null {
  const sameTool = writeEvents
    .filter((e) => e.toolIndex === toolIndex)
    .at(-1)?.branch;
  if (sameTool) {
    return { branch: sameTool, via: "create_tool_evidence" };
  }
  const repoMatches = sessionRepo === null || prRepo === sessionRepo;
  const preceding = repoMatches
    ? writeEvents.filter((e) => e.toolIndex < toolIndex).at(-1)?.branch
    : undefined;
  if (preceding) {
    return { branch: preceding, via: "preceding_write" };
  }
  const raw = tu.gitBranch ?? undefined;
  if (raw && isValidBranchName(raw) && !isDefaultBranchName(raw)) {
    return { branch: raw, via: "tool_git_branch" };
  }
  return null;
}

function extractPullRequestRefs(
  session: NormalizedSession,
  ctx: ExtractContext
): void {
  // Lazily built once — only sessions that actually created a PR pay for it.
  let writeEvents: BranchWriteEvent[] | null = null;
  const sessionRepo = session.artifacts.repo ?? null;

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

      let head: { branch: string; via: string } | null = null;
      if (relation === "created") {
        writeEvents ??= collectBranchWriteEvents(session);
        head = resolveCreatedPrHeadBranch(
          tu,
          i,
          pr.repo,
          sessionRepo,
          writeEvents
        );
      }

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
          ...(head ? { headBranchVia: head.via } : {}),
        }),
        observedAt: ctx.observedAt,
        extractorVersion: EXTRACTOR_VERSION,
        isPrimary: false,
        repoFullName: pr.repo,
        prNumber: pr.number,
        prUrl: pr.url,
        branchName: head?.branch,
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
    if (isValidBranchName(session.gitBranch)) {
      ctx.refs.push({
        targetKind: "branch",
        targetIdentity: session.gitBranch,
        branchName: session.gitBranch,
        relation: "workspace",
        method: "start_branch",
        confidence: "slug_match_in_branch",
        evidence: JSON.stringify({ gitBranch: session.gitBranch }),
        observedAt: ctx.observedAt,
        extractorVersion: EXTRACTOR_VERSION,
        isPrimary: false,
        repoFullName: session.artifacts.repo ?? undefined,
      });
    }
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

// PRD-486: the commit subject is the `[branch sha] subject` summary line,
// captured at the moment the `git commit` ran so the branch rail can show a
// dot per commit without reconstructing history.
function firstCommitSubject(outputTexts: string[]): string | undefined {
  for (const text of outputTexts) {
    const subjectMatch = text.match(GIT_COMMIT_SUBJECT_RE);
    if (subjectMatch?.[1]) {
      return subjectMatch[1].trim();
    }
  }
  return undefined;
}

function extractCommitRefs(
  session: NormalizedSession,
  ctx: ExtractContext
): void {
  for (let i = 0; i < session.toolUses.length; i++) {
    const tu = session.toolUses[i];
    const cmd = shellCommandIfShellTool(tu);
    if (cmd === null || !tu.output) {
      continue;
    }
    // Quote-stripped gate: `rg "git commit …"` is not a commit, and its output
    // (echoed fixture lines full of SHAs) must never mint commit artifacts. The
    // argv form (`["rg", "git commit …"]`) is neutralized identically via
    // shellQuotedSpans — GIT_COMMIT_CMD_RE has no command-boundary anchor, so a
    // bundled arg would otherwise mint phantom commit refs (FEA-2791).
    const strippedCmd = stripQuotedContent(cmd, shellQuotedSpans(tu, cmd));
    if (!GIT_COMMIT_CMD_RE.test(strippedCmd)) {
      continue;
    }

    const outputTexts = flattenTextValues(tu.output);
    const commitSubject = firstCommitSubject(outputTexts);
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

// Write-evidence methods carry `relation: "created"`; reads stay `workspace`.
const BRANCH_WRITE_METHODS: ReadonlySet<string> = new Set(
  BRANCH_WRITE_METHOD_VALUES
);
const BRANCH_PUSH_METHODS: ReadonlySet<string> = new Set(
  BRANCH_PUSH_METHOD_VALUES
);

// Branch-revealing commands whose branch is named in the command itself, as
// regex capture group 1 ?? 2 ?? 3 (the quoted/unquoted-name alternatives).
const BRANCH_COMMAND_PATTERNS: ReadonlyArray<{
  re: RegExp;
  method: string;
  reject?: (branch: string) => boolean;
  skip?: (strippedCmd: string) => boolean;
}> = [
  // git worktree add <path> [-b] <branch>
  { re: GIT_WORKTREE_ADD_ALL_RE, method: "git_worktree_add" },
  // git checkout/switch [-b] <branch>
  { re: GIT_CHECKOUT_ALL_RE, method: "git_checkout", reject: (b) => b === "." },
  // git push [flags] origin <branch>. HEAD is resolved from the push OUTPUT
  // (detectBranchesInOutput), never taken as a branch name; deletes are skipped.
  // The skip runs on the quote-stripped command so a `--delete` inside e.g. a
  // commit -m body cannot suppress a chained real push.
  {
    re: GIT_PUSH_BRANCH_ALL_RE,
    method: "git_push",
    reject: (b) => b === "HEAD",
    skip: (strippedCmd) => GIT_PUSH_DELETE_RE.test(strippedCmd),
  },
];

// Captures run position-checked against the ORIGINAL command (so quoted
// branch names like `git checkout -b "my branch"` still capture — the git
// keyword itself must sit outside quotes); shape gates run on the stripped
// copy. This is the FEA-2531 phantom-branch fix.
function detectBranchesInCommand(
  cmd: string,
  spans: QuotedSpan[],
  strippedCmd: string
): DetectedBranch[] {
  const detected: DetectedBranch[] = [];
  for (const { re, method, reject, skip } of BRANCH_COMMAND_PATTERNS) {
    if (skip?.(strippedCmd)) {
      continue;
    }
    const match = matchOutsideQuotes(cmd, re, spans);
    if (!match) {
      continue;
    }
    const branch = match[1] ?? match[2] ?? match[3];
    if (branch && !branch.startsWith("-") && !reject?.(branch)) {
      detected.push({ branch, method });
    }
  }
  // gh pr create --head/-H names the PR head branch in the command itself —
  // write evidence for the branch AND the created-PR head resolver (FEA-2531).
  if (GH_PR_CREATE_BRANCH_RE.test(strippedCmd)) {
    const flag = matchOutsideQuotes(cmd, GH_PR_HEAD_FLAG_RE, spans);
    const branch = flag?.[1] ?? flag?.[2] ?? flag?.[3];
    if (branch && !branch.startsWith("-")) {
      detected.push({ branch, method: "gh_pr_create" });
    }
  }
  return detected;
}

// Branches echoed in command OUTPUT. The PR URL is already captured in pass 4,
// but the output often also names the branch. All command-shape gates test the
// QUOTE-STRIPPED command: an `rg "git push …"` is not a push, and its output
// (which echoes matching fixture lines) must never be scanned for ref-lines.
function detectBranchesInOutput(
  strippedCmd: string,
  tu: NormalizedToolUse
): DetectedBranch[] {
  if (!tu.output) {
    return [];
  }
  const detected: DetectedBranch[] = [];
  const outputTexts = flattenTextValues(tu.output);

  // gh pr create output names the head ref two ways: "branch 'feat/xxx'" and
  // gh's own "Creating pull request for <head> into <base>" line (FEA-2531).
  if (GH_PR_CREATE_BRANCH_RE.test(strippedCmd)) {
    for (const text of outputTexts) {
      const match = text.match(GH_PR_BRANCH_OUTPUT_RE);
      if (match?.[1]) {
        detected.push({ branch: match[1], method: "gh_pr_create" });
      }
      const headMatch = text.match(GH_PR_CREATE_HEAD_OUTPUT_RE);
      if (headMatch?.[1]) {
        detected.push({ branch: headMatch[1], method: "gh_pr_create" });
      }
    }
  }

  // git commit summary line, e.g. "[feat/fea-1684 abc1234] message".
  if (GIT_COMMIT_CMD_RE.test(strippedCmd)) {
    for (const text of outputTexts) {
      const match = text.match(GIT_COMMIT_BRANCH_RE);
      if (match?.[1]) {
        detected.push({ branch: match[1], method: "git_commit" });
      }
    }
  }

  // git push output names the remote branch even when the command doesn't
  // (`git push origin HEAD`, `--set-upstream`) — FEA-2531 push evidence.
  if (
    GIT_PUSH_CMD_RE.test(strippedCmd) &&
    !GIT_PUSH_DELETE_RE.test(strippedCmd)
  ) {
    detectPushedBranchesInOutput(outputTexts, detected);
  }
  return detected;
}

function detectPushedBranchesInOutput(
  outputTexts: string[],
  detected: DetectedBranch[]
): void {
  for (const text of outputTexts) {
    const branch =
      text.match(GIT_PUSH_OUTPUT_REF_RE)?.[2] ??
      text.match(GIT_PUSH_UPSTREAM_OUTPUT_RE)?.[1];
    if (branch && branch !== "HEAD") {
      detected.push({ branch, method: "git_push" });
    }
  }
}

// Push a branch ref for each detected branch, plus any Closedloop slug embedded
// in the branch name (case-insensitive: branch names like feat/fea-1684).
function pushBranchRefs(
  ctx: ExtractContext,
  session: NormalizedSession,
  toolIndex: number,
  cmd: string,
  detected: DetectedBranch[],
  tu: NormalizedToolUse
): void {
  // Event time, not scan time — slug refs below keep scan-time observedAt.
  const eventTime = tu.timestamp ?? ctx.observedAt;
  for (const { branch, method } of detected) {
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

    if (!isValidBranchName(branch)) {
      continue;
    }

    // PRD-510 C1: a failed push never reached the remote — not push evidence.
    // Covers every push method (git_push AND gh_pr_create) — a failed
    // `gh pr create --head` mints no branch either (FEA-2789).
    if (BRANCH_PUSH_METHODS.has(method) && tu.isError === true) {
      continue;
    }

    ctx.refs.push({
      targetKind: "branch",
      targetIdentity: branch,
      branchName: branch,
      relation: BRANCH_WRITE_METHODS.has(method) ? "created" : "workspace",
      method,
      confidence: "url_match",
      evidence: JSON.stringify({ toolIndex, command: cmd.slice(0, 200) }),
      observedAt: eventTime,
      extractorVersion: EXTRACTOR_VERSION,
      isPrimary: false,
      repoFullName: session.artifacts.repo ?? undefined,
    });
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
    const spans = shellQuotedSpans(tu, cmd);
    const strippedCmd = stripQuotedContent(cmd, spans);
    // Order matters: command-named branches first, then output-echoed ones —
    // this preserves the original push order for downstream dedup precedence.
    const detected = [
      ...detectBranchesInCommand(cmd, spans, strippedCmd),
      ...detectBranchesInOutput(strippedCmd, tu),
    ];
    pushBranchRefs(ctx, session, i, cmd, detected, tu);
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

// FEA-2531: same-relation branch refs collapse to one row per (session,
// artifact, relation), so the survivor must carry the STRONGEST evidence —
// a commit-then-push session must keep the push ref (it stamps
// first_pushed_at and satisfies the display gate), not the earlier commit.
// Ties keep the first (earliest event time), so the earliest push survives.
function branchEvidenceRank(ref: ArtifactRefRecord): number {
  if (ref.targetKind !== "branch") {
    return 0;
  }
  if (BRANCH_PUSH_METHODS.has(ref.method)) {
    return 2;
  }
  if (BRANCH_WRITE_METHODS.has(ref.method)) {
    return 1;
  }
  return 0;
}

function deduplicateRefs(refs: ArtifactRefRecord[]): ArtifactRefRecord[] {
  const map = new Map<string, ArtifactRefRecord>();
  for (const ref of refs) {
    const key = `${ref.targetKind}|${ref.targetIdentity}|${ref.relation}`;
    const existing = map.get(key);
    const confidence = (r: ArtifactRefRecord) =>
      CONFIDENCE_RANK[r.confidence] ?? 0;
    if (
      !existing ||
      confidence(ref) > confidence(existing) ||
      (confidence(ref) === confidence(existing) &&
        branchEvidenceRank(ref) > branchEvidenceRank(existing))
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
