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
import type { ArtifactRefRelation } from "@repo/api/src/types/session-artifact-link";
import {
  ArtifactRefMethod,
  parsePullRequestNumber,
} from "@repo/api/src/types/session-artifact-link";
import { buildSlugPrefixAlternation } from "@repo/api/src/types/slug-prefix";
import {
  collectSessionToolUses,
  type IndexedToolUse,
} from "@repo/lib/harness/session-tool-uses";
import {
  BRANCH_PUSH_METHOD_VALUES,
  BRANCH_WRITE_METHOD_VALUES,
} from "../../database/db-constants.js";
import { isValidBranchName } from "../../enrichment/branch-validation.js";
import type { NormalizedSession, NormalizedToolUse } from "../types.js";
import {
  BRANCH_COMMAND_PATTERNS,
  GH_PR_HEAD_FLAG_RE,
  GIT_PUSH_CMD_RE,
  GIT_PUSH_DELETE_RE,
  GIT_PUSH_OUTPUT_REF_RE,
  GIT_PUSH_UPSTREAM_OUTPUT_RE,
} from "./artifact-ref-branch-patterns.js";
import {
  GH_PR_CREATE_REGEX,
  GH_PR_FEEDBACK_WRITE_CMD_RE,
  GH_PR_REVIEW_CMD_RE,
} from "./artifact-ref-command-patterns.js";
import {
  type BranchWriteEvent,
  createdPrHeadFromGhOutput,
  resolveCreatedPrBaseRef,
  resolveCreatedPrHeadBranch,
} from "./artifact-ref-created-pr-evidence.js";
import { EXTRACTOR_VERSION } from "./artifact-ref-extractor-version.js";
import {
  CLOSEDLOOP_SLUG_RE,
  extractMcpToolInputSlugs,
  extractMcpToolOutputSlugs,
  isClosedloopMcpTool,
} from "./artifact-ref-mcp-slugs.js";
import {
  resolveRefObservedAt,
  resolveSessionObservedAt,
} from "./artifact-ref-observed-at.js";
import { extractProseMentionRefs } from "./artifact-ref-prose-refs.js";
import type { ArtifactRefRecord } from "./artifact-ref-record.js";
import {
  matchOutsideQuotes,
  type QuotedSpan,
  shellQuotedSpans,
  stripNeutralizedContent,
  stripQuotedContent,
} from "./artifact-ref-shell-quotes.js";
import {
  attachMonitoredSessionActivity,
  MonitoredSessionCliRefMethod,
  reconcileMonitoredSessionActivityRefs,
} from "./monitored-session-activity.js";
import {
  FIXTURE_OWNER_RE,
  flattenTextValues,
  GITHUB_PR_URL_RE,
  isShellCommandToolUse,
  PR_TOOL_PATTERNS,
  shellCommand,
} from "./parser-utils.js";

export const LAUNCH_METADATA_REF_METHOD = "launch_metadata";

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

// The digit run is deliberately unbounded. A width cap makes the boundary-anchored
// forms silently STOP matching once slug numbering crosses it, and makes the
// unanchored URL form silently TRUNCATE to a different, wrong slug. The family
// prefix is the only thing worth asserting here; artifact resolution downstream
// decides whether the slug names something real.
// FEA-4137: `ISS` (Issues) is the canonical prefix for the artifact formerly
// called "Feature"; `FEA` stays accepted as a compat alias (existing sessions,
// PR bodies, and bookmarks still carry FEA-###). Both resolve to the same
// numeric identity downstream. The accepted prefix alphabet is driven from the
// single REFERENCEABLE_SLUG_PREFIXES SSOT in @repo/api so every recognizer in
// this file — plus the cloud sync-schema validator and the branch-name parser —
// stays in lockstep and a future prefix never has to be added in six places.
const SLUG_PREFIX_ALT = buildSlugPrefixAlternation();

// The `[a-zA-Z0-9_-]+` org-slug segment is matched but intentionally
// discarded: slugs are resolved to artifacts scoped to the importing org
// downstream, so the org segment in the URL carries no authority here.
// FEA-4137: `issues` is the canonical Issue route path; `features` is the retired
// alias path (legacy links keep resolving via a 302 redirect), so both are
// accepted here alongside the ISS/FEA slug prefixes.
const CLOSEDLOOP_URL_RE = new RegExp(
  String.raw`https://app\.closedloop\.ai/[a-zA-Z0-9_-]+/(?:documents|issues|features|plans|implementation-plans|prds|projects)/((${SLUG_PREFIX_ALT})-\d+)`,
  "g"
);

const GIT_COMMIT_CMD_RE = /git\s+commit/;

// The reviewed PR number as a bare positional token: `gh pr view 2990` /
// `gh pr diff #2990`. Excludes flag tokens (leading `-`) via the caller's scan.
const GH_PR_REVIEW_NUMBER_ARG_RE =
  /gh\s+pr\s+(?:view|diff|review|checkout|comment)\b((?:\s+(?:-{1,2}\S+))*)\s+#?(\d+)(?=$|[\s;&|)])/;

// FEA-3585 review fix: a valid `owner/repo` slug (mirrors db-helpers'
// GITHUB_REPO_FULL_NAME_RE). Guards the bare-number reviewed-PR path from
// borrowing a repo-less cwd basename as a PR identity.
const OWNER_REPO_SLUG_RE = /^[\w.-]+\/[\w.-]+$/;

const FENCE_OPEN_RE = /^(`{3,})/;
const INLINE_CODE_RE = /`[^`]+`/g;
// FEA-4137: the launch-metadata (anchored), session-slug (full-match), and
// cwd/branch-name (case-insensitive) slug recognizers derive their accepted
// prefix alphabet from the SAME SSOT (SLUG_PREFIX_ALT, incl. ISS) as the prose
// and URL regexes above — so an `ISS-593` branch, cwd path, launch-metadata
// slug, or session slug produces its input/workspace links, not just an
// `ISS-###` in prose. Previously FEA-only, which silently dropped every Issue
// attribution that arrived through those non-prose input paths.
const CLOSEDLOOP_SLUG_ANCHORED_RE = new RegExp(
  String.raw`\b(${SLUG_PREFIX_ALT})-\d+\b`
);
export const CLOSEDLOOP_SLUG_FULL_MATCH_RE = new RegExp(
  String.raw`^(${SLUG_PREFIX_ALT})-\d+$`
);
const CLOSEDLOOP_SLUG_BRANCH_RE = new RegExp(
  String.raw`\b(${SLUG_PREFIX_ALT})-\d+\b`,
  "i"
);
const TRAILING_SLASHES_RE = /\/+$/;
const GH_PR_BRANCH_OUTPUT_RE = /branch\s+'([^']+)'/;
// The branch-detection pass (Section 7) keys on this: the first bracket token
// when a full sha and the closing bracket follow it — i.e. the `[<branch> <sha>]`
// shape only. It deliberately does NOT match `[detached HEAD <sha>]` or
// `[<branch> (root-commit) <sha>]` (sha not adjacent to the first token).
//
// ISS-8751: the sha run and the `]` are both load-bearing. This pattern used to
// require a SINGLE hex character and no closing bracket, which made any bracketed
// log line whose second word merely STARTS with 0-9a-f a commit summary — so
// `[lc diagnostics: errors=0, …]` in the output of a tool call that also ran a
// `git commit` minted a phantom branch named `lc` with a write link, which then
// reached the Branches surface and drew token attribution. Across the golden
// corpus the old shape captured 53 distinct tokens (`Errno` from a Python
// traceback, `List` and `Some` from prompt templates, …) against this shape's 4,
// all of them real branches.
//
// Deliberately ONE notch looser than GIT_COMMIT_SUMMARY_RE alt A, which also
// requires a non-empty subject after the `]`: this pass must never be NARROWER
// than the commit pass, or a commit could mint with no branch row for it to
// resolve onto. Looser in that one direction is safe; the two agree on every
// line in the corpus.
const GIT_COMMIT_BRANCH_RE = /^\[([^\s\]]+)\s+[0-9a-f]{7,40}\]/m;
// One match per `git commit` summary line — `[<ref> <sha>] <subject>` — the
// authoritative "a commit happened" record, parsed in a single pass so branch,
// sha, and subject come from the SAME line (a multi-commit output must label each
// commit with its own, not the first line's):
//   • Alt A `[<branch> <sha>]` — branch adjacent to sha: branch = group 1,
//     sha = group 2. This is the strict shape GIT_COMMIT_BRANCH_RE also keys on,
//     so the two parses stay identical (parity the cloud commit→branch resolve
//     relies on), including all-hex branch names.
//   • Alt B `[… <sha>]` — sha NOT adjacent to the first token (detached HEAD,
//     root-commit): sha = group 3, no branch.
// The sha is always the last 7–40 hex run before `]`, so an all-hex branch is not
// mistaken for it. group 4 is the subject. Every OTHER hex token in the output —
// a stash sha from a husky/lint-staged state backup (`Backed up original state in
// git stash (deadbee…)`), a tree/object hash, diff context — is outside a summary
// bracket and mints nothing: it can neither inherit a branch nor sync as a
// phantom CommitDetail. Global so matchAll yields one ref per commit.
const GIT_COMMIT_SUMMARY_RE =
  /^\[(?:([^\s\]]+)\s+([0-9a-f]{7,40})|[^\]]*?\s([0-9a-f]{7,40}))\]\s+(.+)$/gm;

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
      const number = parsePullRequestNumber(num);
      if (number === null) {
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
        number,
      });
    }
  }
  return refs;
}

// Shared shell/git-command guard used by the commit and branch passes: returns
// the normalized command string for a shell-family tool use (possibly empty),
// or null for non-shell tools. Callers skip a tool use when this is null.
// A non-shell tool that merely carries a command string in an argument is not a
// shell command and must not count.
// ISS-8268: the predicate is structural, so shell-through-MCP tools (an MCP
// tool with an explicit `command`/`cmd` input field) qualify alongside the
// builtin Bash/shell/exec_command set.
export function shellCommandIfShellTool(tu: NormalizedToolUse): string | null {
  return isShellCommandToolUse(tu) ? shellCommand(tu) : null;
}

export function isPrCreateCommand(tu: NormalizedToolUse): boolean {
  if (isShellCommandToolUse(tu)) {
    // Quote-stripped so `echo "… gh pr create …"` and friends don't classify
    // a merely-quoted mention as the create command (FEA-2531 hardening).
    const cmd = shellCommand(tu);
    return GH_PR_CREATE_REGEX.test(stripNeutralizedContent(cmd));
  }
  return PR_TOOL_PATTERNS.has(tu.name);
}

// --- Main extractor: a registry of named single-responsibility passes ---
//
// Each pass takes (session, ctx) and pushes records onto the shared `ctx.refs`
// accumulator, stamping each ref's own event instant where it has one and
// falling back to `ctx.observedAt` (ISS-5236: session start, NOT the import
// clock — see artifact-ref-observed-at.ts). The extractor runs the passes in
// order, then deduplicates and selects the primary.
// Splitting the former 7-branch monolith into named passes keeps each one
// individually simple and independently testable; ORDER IS PRESERVED so the
// dedup confidence-ranking and primary-method precedence behave identically.

type ExtractContext = {
  /** ISS-5236: session-start fallback for refs with no own event instant. */
  readonly observedAt: string;
  /** Shared accumulator every pass appends to. */
  readonly refs: ArtifactRefRecord[];
  /**
   * ISS-5934: the parent+sidecar tool-use stream, materialized ONCE per session
   * and threaded to every pass that scans it. `collectSessionToolUses` walks the
   * parent's tool uses AND every sidecar sub-agent's and builds a dedup `Set` of
   * parent tool-use ids, so calling it per pass re-paid that whole walk 4-5×
   * per session on boot import and on every `DATA_REVISION` rebuild.
   */
  readonly toolUses: readonly IndexedToolUse[];
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
        observedAt: resolveRefObservedAt(tu.timestamp, ctx.observedAt),
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
        observedAt: resolveRefObservedAt(tu.timestamp, ctx.observedAt),
        extractorVersion: EXTRACTOR_VERSION,
        isPrimary: false,
      });
    }
  }
}

// --- 2. Closedloop URL refs (tool input AND output, plus message text) ---
// Push a Closedloop-artifact ref for every app.closedloop.ai URL in one text.
// ISS-5236: `eventTime` (the instant of the tool use / message the URL was read
// out of) is load-bearing, not optional polish — `url_match` outranks
// `slug_match_in_prose` and this pass runs FIRST, so a slug appearing both bare
// and as a URL collapses onto one dedup key and THIS record is the survivor
// `deduplicateRefs` keeps wholesale, discarding whatever instant the bare-slug
// pass resolved.
function pushClosedloopUrlRefs(
  ctx: ExtractContext,
  text: string,
  relation: ArtifactRefRelation,
  eventTime: string | null | undefined,
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
      observedAt: resolveRefObservedAt(eventTime, ctx.observedAt),
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
      pushClosedloopUrlRefs(ctx, text, "input", tu.timestamp, {
        toolIndex: i,
        source: "tool_input",
      });
    }
    for (const text of flattenTextValues(tu.output)) {
      pushClosedloopUrlRefs(ctx, text, "output", tu.timestamp, {
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
    pushClosedloopUrlRefs(ctx, msg.text, "input", msg.timestamp, {
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
        observedAt: resolveRefObservedAt(msg.timestamp, ctx.observedAt),
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
          observedAt: resolveRefObservedAt(tu.timestamp, ctx.observedAt),
          extractorVersion: EXTRACTOR_VERSION,
          isPrimary: false,
        });
      }
    }
  }
}

// --- 4. PR refs with created-vs-referenced distinction ---

// Branch WRITE evidence per tool use — the same quote-aware detections the
// branch pass (7) stores as links, reused so a created PR's head ref resolves
// from the session's own write relationships (FEA-2531) instead of the
// harness-reported CWD branch. Only write methods qualify, and a failed push
// is excluded exactly as in pushBranchRefs.
function collectBranchWriteEvents(
  toolUses: readonly IndexedToolUse[]
): BranchWriteEvent[] {
  const events: BranchWriteEvent[] = [];
  // FEA-3627: scan the parent's own tool uses AND sidecar sub-agent tool uses so
  // a sub-agent-created PR resolves its head ref from the sub-agent's own branch
  // write (which lives only in `subagent.toolUses`).
  for (const { tu, toolIndex, agentId } of toolUses) {
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
      if (!isValidBranchName(branch)) {
        continue;
      }
      events.push({ toolIndex, branch, agentId });
    }
  }
  return events;
}

// FEA-3585: does this tool-use RUN a `gh pr` review subcommand (view/diff/
// review/checkout/comment) against a specific PR? Tested on the quote-stripped
// command so an `echo "gh pr view 5"` mention (the string sits inside a quoted
// argument) does not classify as a review — the SAME hardening isPrCreateCommand
// applies. Non-shell tools never run a review command.
function isPrReviewCommand(tu: NormalizedToolUse): string | null {
  if (!isShellCommandToolUse(tu)) {
    return null;
  }
  const cmd = shellCommand(tu);
  const stripped = stripNeutralizedContent(cmd);
  return GH_PR_REVIEW_CMD_RE.test(stripped) ? cmd : null;
}

// The reviewed PR named as a BARE NUMBER positional (`gh pr view 2990`,
// `gh pr diff #2990`) when the command carries no PR URL. Resolves against the
// quote-stripped command (a number inside a quoted arg is not the positional).
// The repo comes from the session (a bare number has no repo of its own); with
// no session repo the number can't form an identity and is skipped.
function detectReviewedPrNumber(
  strippedCmd: string,
  sessionRepo: string | null
): { repo: string; number: number } | null {
  // FEA-3585 review fix: a bare-number review (`gh pr view 2990`) borrows the
  // session repo for its identity, but session.artifacts.repo can be a bare cwd
  // BASENAME (extractRepoFromCwd → path.basename(cwd), e.g. "closedloop-ai"
  // with no owner). Synthesizing `basename#N` mints a repo-less/ambiguous PR
  // artifact that can never reconcile to a real GitHub PR. Require a full
  // owner/repo slug; skip the bare-number ref otherwise (a URL positional still
  // carries its own owner/repo and is unaffected).
  if (!(sessionRepo && OWNER_REPO_SLUG_RE.test(sessionRepo))) {
    return null;
  }
  const m = strippedCmd.match(GH_PR_REVIEW_NUMBER_ARG_RE);
  if (!m) {
    return null;
  }
  const number = parsePullRequestNumber(m[2]);
  return number === null ? null : { repo: sessionRepo, number };
}

// FEA-3851: classify ONE sub-command segment's review method. A segment that
// runs a feedback-write subcommand (`gh pr review` / `gh pr comment`) is
// `PrReviewFeedbackCommand`; every other review segment (view/diff/checkout) is
// the read-only `PrReviewCommand`. On a whole-command `isError`, a feedback
// write is demoted to read-only UNLESS a later segment is chained AFTER it with
// `&&` — that `&&` only runs its right-hand side when the feedback segment
// itself exited 0, so it proves the write COMPLETED before the failing suffix
// (FEA-3851). A lone/last feedback segment (or one whose successor is joined by
// `;`/`|`/`&`, which run regardless of the feedback segment's exit) has no such
// proof, so a `gh pr review` that itself failed — the FEA-3803 single-command
// case included — is demoted. `segments.length > 1` alone did NOT prove the
// feedback write ran; the `&&`-successor check does.
function prReviewMethodForSegment(
  segment: ShellSegment,
  segments: ShellSegment[],
  index: number,
  toolUseIsError: boolean
): ArtifactRefMethod {
  const isFeedbackWrite = GH_PR_FEEDBACK_WRITE_CMD_RE.test(segment.text);
  if (!isFeedbackWrite) {
    return ArtifactRefMethod.PrReviewCommand;
  }
  if (toolUseIsError && !hasAndChainedSuccessor(segments, index)) {
    return ArtifactRefMethod.PrReviewCommand;
  }
  return ArtifactRefMethod.PrReviewFeedbackCommand;
}

// A feedback segment "completed before a failing suffix" only when the NEXT
// segment is chained to it with `&&`: `A && B` runs B only if A exited 0, so a
// segment with an `&&`-joined successor is proven to have succeeded even when
// the whole tool-use errored. `;`/`|`/`&`/newline successors run regardless of
// the segment's exit, so they prove nothing.
function hasAndChainedSuccessor(
  segments: ShellSegment[],
  index: number
): boolean {
  const next = segments[index + 1];
  return next?.precedingOperator === "&&";
}

// FEA-3851: split a QUOTE-STRIPPED shell command into its sequential
// sub-command segments on unquoted shell control operators, KEEPING the
// operator that precedes each segment (needed to prove `&&`-chained ordering
// above). stripQuotedContent has already blanked quoted content to spaces, so a
// separator that lived inside a quoted argument is gone and cannot split a
// segment. The two-character operators `&&`/`||` are matched before the
// single-character `|`/`&` so they win. A bare `&` matches ONLY as a control
// operator: a `&` that is part of a redirection (`2>&1`, `>&2`, `&>file`) or an
// escaped `\&` is NOT a command separator, so `gh pr review 42 2>&1` stays ONE
// segment (the FEA-3851 redirection fix — a lone failed review no longer splits
// into two segments and dodges the isError demotion). A PR URL or bare `gh pr …
// <number>` token never spans a separator, so each reviewed PR is fully
// contained in exactly one segment and classified from THAT segment.
type ShellSegment = { text: string; precedingOperator: ShellOperator | null };
type ShellOperator = "&&" | "||" | ";" | "|" | "&" | "\n";
const SHELL_SUBCOMMAND_SEP_RE = /(&&|\|\||;|<&|>&|&>|\|&|\\&|\||&|\n)/;
const REDIRECTION_OR_ESCAPED_AMP_SET = new Set(["<&", ">&", "&>", "|&", "\\&"]);

function splitShellSubcommands(strippedCmd: string): ShellSegment[] {
  const parts = strippedCmd.split(SHELL_SUBCOMMAND_SEP_RE);
  const segments: ShellSegment[] = [];
  let pendingOperator: ShellOperator | null = null;
  let carry = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    // Odd indices are the captured separators. A redirection / escaped `&` is
    // NOT a control operator: keep it glued to the surrounding text so it does
    // not split a segment.
    if (i % 2 === 1) {
      if (REDIRECTION_OR_ESCAPED_AMP_SET.has(part)) {
        carry += part;
        continue;
      }
      const pushed = pushShellSegment(segments, carry, pendingOperator);
      carry = "";
      // If the accumulated text was empty (e.g. a leading separator or `;;`),
      // keep the FIRST operator so the next non-empty segment records the
      // control operator that truly precedes it, not a later one.
      pendingOperator =
        pushed || pendingOperator === null
          ? (part as ShellOperator)
          : pendingOperator;
      continue;
    }
    carry += part;
  }
  pushShellSegment(segments, carry, pendingOperator);
  return segments;
}

function pushShellSegment(
  segments: ShellSegment[],
  rawText: string,
  precedingOperator: ShellOperator | null
): boolean {
  const text = rawText.trim();
  if (text.length === 0) {
    return false;
  }
  segments.push({ text, precedingOperator });
  return true;
}

// Push a PR ref for the reviewed PR: `relation: "reviewed"` distinguishes a
// review session from an authoring one and attributes it to the PR the session
// actually operated on (FEA-3585). A URL positional carries the repo directly;
// a bare number borrows the session repo. Never resolves a head branch — the
// reviewer authored no branch.
function pushReviewedPrRef(
  ctx: ExtractContext,
  toolIndex: number,
  toolName: string,
  repo: string,
  number: number,
  prUrl: string | undefined,
  method: ArtifactRefMethod,
  observedAt: string
): void {
  ctx.refs.push({
    targetKind: "pull_request",
    targetIdentity: `${repo}#${number}`,
    relation: "reviewed",
    method,
    confidence: "url_match",
    evidence: JSON.stringify({
      toolIndex,
      toolName,
      ...(prUrl ? { prUrl } : { prNumberArg: number }),
    }),
    observedAt,
    extractorVersion: EXTRACTOR_VERSION,
    isPrimary: false,
    repoFullName: repo,
    prNumber: number,
    ...(prUrl ? { prUrl } : {}),
  });
}

// FEA-3585: emit `reviewed` PR refs for a `gh pr view/diff/review <n>` review
// subcommand and return the set of reviewed `repo#number` identities so the
// caller can suppress a duplicate `referenced` row for the same PR (no
// double-count). A review reviews the PR named in the COMMAND (its input
// positional) — never one merely echoed in output or mentioned elsewhere in
// prose. A URL positional is upgraded to `reviewed`; a bare-number positional
// (which produces no URL ref at all, the #2990-not-linked bug) is synthesized
// from the session repo. Non-review tool uses return an empty set.
//
// FEA-3851: a bundled tool-use like `gh pr view <A> && gh pr review <B>` is
// classified PER SUB-COMMAND SEGMENT, not per whole command. Previously the
// feedback-write method (and the whole-command `isError`) were computed against
// the ENTIRE command string, so a merely-VIEWED PR (A) inherited B's
// feedback-write method — minting a wrong `ReviewFeedback` branch-lifecycle
// boundary in the cloud (the exact over-attribution FEA-3803 aimed to prevent),
// while a failing unrelated sibling demoted B's genuine write. Each reviewed PR
// now takes the method of the segment that actually named it.
function emitReviewedPrRefs(
  ctx: ExtractContext,
  tu: NormalizedToolUse,
  toolIndex: number,
  sessionRepo: string | null
): Set<string> {
  const reviewedIdentities = new Set<string>();
  const reviewCmd = isPrReviewCommand(tu);
  if (!reviewCmd) {
    return reviewedIdentities;
  }
  // FEA-3585 review fix: the reviewed PR is the one named on the COMMAND LINE,
  // not any PR URL that merely appears in a SIBLING input field (e.g. the Bash
  // tool's `description`, which `flattenTextValues(tu.input)` also flattens).
  // Resolve the positional against the QUOTE-STRIPPED command string itself so
  // neither a URL in `description` nor one echoed inside a quoted argument of
  // the review command can be substituted for the command's actual target
  // (same quote-stripping the bare-number path already applies).
  const strippedCmd = stripNeutralizedContent(reviewCmd);
  const eventTime = resolveRefObservedAt(tu.timestamp, ctx.observedAt);
  const toolUseIsError = tu.isError === true;
  const segments = splitShellSubcommands(strippedCmd);
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    // Only a segment that itself runs a `gh pr` review subcommand contributes a
    // `reviewed` PR — a PR merely echoed in a sibling `echo`/other segment is
    // not reviewed and falls through to the caller's `referenced` handling.
    if (!GH_PR_REVIEW_CMD_RE.test(segment.text)) {
      continue;
    }
    const method = prReviewMethodForSegment(
      segment,
      segments,
      index,
      toolUseIsError
    );
    const segmentPrs = extractPrUrlsFromTexts([segment.text]);
    for (const pr of segmentPrs) {
      reviewedIdentities.add(`${pr.repo}#${pr.number}`);
      pushReviewedPrRef(
        ctx,
        toolIndex,
        tu.name,
        pr.repo,
        pr.number,
        pr.url,
        method,
        eventTime
      );
    }
    if (segmentPrs.length === 0) {
      const numbered = detectReviewedPrNumber(segment.text, sessionRepo);
      if (numbered) {
        reviewedIdentities.add(`${numbered.repo}#${numbered.number}`);
        pushReviewedPrRef(
          ctx,
          toolIndex,
          tu.name,
          numbered.repo,
          numbered.number,
          undefined,
          method,
          eventTime
        );
      }
    }
  }
  return reviewedIdentities;
}

type PrRefContext = {
  ctx: ExtractContext;
  tu: NormalizedToolUse;
  toolIndex: number;
  // FEA-3627: sub-agent id of the create tool-use, so created-PR head-branch
  // resolution's preceding-write lookup stays fenced to the same sub-agent block.
  agentId: string | null;
  sessionRepo: string | null;
  // Event time of the create tool use (tu.timestamp), scan time as fallback.
  eventTime: string;
  inOutput: boolean;
  inInput: boolean;
  // ISS-8175: how many refs this tool-use will mark `created`, so a base can be
  // bound only when gh printed exactly one create line per created PR.
  createdRefCount: number;
  // Lazily-built branch-write evidence, shared across PRs in this session.
  getWriteEvents: () => BranchWriteEvent[];
};

// Build and push ONE PR ref for `pr`, deciding created-vs-referenced and, for a
// created PR, resolving its head branch (FEA-2531). Extracted so the scanning
// loop in extractPullRequestRefs stays under the cognitive-complexity ceiling.
function pushPullRequestRef(
  prCtx: PrRefContext,
  pr: { repo: string; number: number; url: string }
): void {
  const { ctx, tu, toolIndex, agentId, sessionRepo, eventTime } = prCtx;
  const isCreated = isPrCreateCommand(tu) && prCtx.inOutput && !prCtx.inInput;

  const head = isCreated
    ? resolveCreatedPrHeadBranch(
        toolIndex,
        agentId,
        pr.repo,
        sessionRepo,
        prCtx.getWriteEvents()
      )
    : null;
  const baseRef = isCreated
    ? resolveCreatedPrBaseRef(tu, prCtx.createdRefCount)
    : null;

  ctx.refs.push({
    targetKind: "pull_request",
    targetIdentity: `${pr.repo}#${pr.number}`,
    relation: isCreated ? "created" : "referenced",
    method: isCreated ? "pr_create_output" : "pr_url_in_tool_use",
    confidence: "url_match",
    evidence: JSON.stringify({
      toolIndex,
      toolName: tu.name,
      prUrl: pr.url,
      ...(head ? { headBranchVia: head.via } : {}),
    }),
    // FEA-3635 (comment 3): a CREATED PR ref stamps its `observedAt` from the
    // create tool-use's own event time (tu.timestamp) — exactly as the branch
    // (pushBranchRefs) and commit (pushCommitRefs) passes already do — so the
    // "PR #N opened" timeline dot lands on the create turn instead of the
    // synthetic per-import scan `now`. session-artifact-markers falls back to
    // this link `observed_at` whenever pull_requests.opened_at (GitHub
    // createdAt) is not yet enriched, so this positions the pre-enrichment
    // marker at the real open turn. A `referenced` mention keeps scan-time
    // observedAt: it never mints a marker (only created/workspace relations do),
    // so a later re-mention of the same PR can't drag the open dot to the last
    // occurrence (comment 2).
    observedAt: isCreated ? eventTime : ctx.observedAt,
    extractorVersion: EXTRACTOR_VERSION,
    isPrimary: false,
    repoFullName: pr.repo,
    prNumber: pr.number,
    prUrl: pr.url,
    branchName: head?.branch,
    // Omitted rather than nulled when gh named no base — an absent base is the
    // honest unknown the cloud read already renders (ISS-8155).
    ...(baseRef ? { baseRef } : {}),
  });
}

function extractPullRequestRefs(
  session: NormalizedSession,
  ctx: ExtractContext
): void {
  // Lazily built once — only sessions that actually created a PR pay for it.
  let writeEvents: BranchWriteEvent[] | null = null;
  const getWriteEvents = (): BranchWriteEvent[] => {
    writeEvents ??= collectBranchWriteEvents(ctx.toolUses);
    return writeEvents;
  };
  const sessionRepo = session.artifacts.repo ?? null;

  // FEA-3627: scan sidecar sub-agent tool uses too so a PR created by a
  // Task-spawned sub-agent (`gh pr create` in a `subagents/agent-*.jsonl`
  // sidecar) is attributed to the PARENT session. In-line sidechain tools are
  // deduped by id inside collectSessionToolUses (no double-count).
  for (const { tu, toolIndex: i, agentId } of ctx.toolUses) {
    const inputTexts = flattenTextValues(tu.input);
    const outputTexts = flattenTextValues(tu.output);
    const inputPrs = extractPrUrlsFromTexts(inputTexts);
    const inputUrls = new Set(inputPrs.map((r) => r.url));
    const outputPrs = extractPrUrlsFromTexts(outputTexts);
    // ISS-5934: derived, not a third sweep over the same texts.
    // `extractPrUrlsFromTexts` dedups by url in first-seen order, so its result
    // over `[...inputTexts, ...outputTexts]` is exactly the input hits followed
    // by the output hits it had not already seen.
    const allPrs = inputPrs.concat(
      outputPrs.filter((pr) => !inputUrls.has(pr.url))
    );

    const reviewedIdentities = emitReviewedPrRefs(ctx, tu, i, sessionRepo);
    // ISS-8175: the same created-vs-referenced decision `pushPullRequestRef`
    // makes per PR, counted up front — a base is bindable only when gh printed
    // one create line for each ref this tool-use marks `created`. Membership in
    // `allPrs` already implies the URL is in the output, so `!inputUrls.has`
    // is exactly that function's `inOutput && !inInput`.
    const createdRefCount = isPrCreateCommand(tu)
      ? allPrs.filter(
          (pr) =>
            !(
              inputUrls.has(pr.url) ||
              reviewedIdentities.has(`${pr.repo}#${pr.number}`)
            )
        ).length
      : 0;

    for (const pr of allPrs) {
      // Already emitted as `reviewed` above — don't also emit a `referenced`
      // row for the SAME PR from the same review command (no double-count).
      if (reviewedIdentities.has(`${pr.repo}#${pr.number}`)) {
        continue;
      }
      pushPullRequestRef(
        {
          ctx,
          tu,
          toolIndex: i,
          agentId,
          sessionRepo,
          eventTime: resolveRefObservedAt(tu.timestamp, ctx.observedAt),
          inOutput: outputPrs.some((p) => p.url === pr.url),
          inInput: inputUrls.has(pr.url),
          createdRefCount,
          getWriteEvents,
        },
        pr
      );
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

function extractCommitRefs(
  session: NormalizedSession,
  ctx: ExtractContext
): void {
  // FEA-3627: include sidecar sub-agent tool uses so a sub-agent's `git commit`
  // is attributed to the parent session (its LOC then reaches git enrichment).
  for (const { tu, toolIndex: i } of ctx.toolUses) {
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
    pushCommitRefs(ctx, session, i, cmd, tu, outputTexts);
  }
}

// Push one commit ref per `[<branch> <sha>] <subject>` summary line in a `git
// commit`'s output (GIT_COMMIT_SUMMARY_RE, matchAll) — NOT one per hex token —
// deriving the branch, sha, AND subject from the SAME match so a multi-commit
// output (two `git commit` runs, or a rebase/cherry-pick echo) labels each
// commit with ITS OWN branch/subject, not the first line's. Restricting to the
// summary sha keeps noise SHAs (stash backups, object hashes) from inheriting a
// commit's branch and syncing as phantom commits. The branch is captured only in
// the strict `[<branch> <sha>]` shape (branch adjacent to sha) and gated by
// isValidBranchName — the SAME shape + gate the Section-7 branch pass keys on, so
// the commit resolves onto the branch row that pass mints; detached-HEAD / root
// commits (sha not adjacent to the first token) yield no branch and are dropped
// by the sync payload rather than sent unresolvable. Extracted from
// extractCommitRefs to keep each within the cognitive-complexity budget.
function pushCommitRefs(
  ctx: ExtractContext,
  session: NormalizedSession,
  toolIndex: number,
  cmd: string,
  tu: NormalizedToolUse,
  outputTexts: string[]
): void {
  // No transcript timestamp → leave committedAt unset (do NOT fall back to
  // observedAt/scan time). A scan-time value would pass the `committed_at IS
  // NOT NULL` read filter and reintroduce the FEA-2022 regression; the SHA-only
  // commit row is instead simply skipped by the rail (no dot, no activity bump).
  const committedAt = tu.timestamp ?? undefined;
  for (const text of outputTexts) {
    for (const m of text.matchAll(GIT_COMMIT_SUMMARY_RE)) {
      const branchCandidate = m[1];
      const sha = m[2] ?? m[3];
      const branchName =
        branchCandidate && isValidBranchName(branchCandidate)
          ? branchCandidate
          : undefined;
      ctx.refs.push({
        targetKind: "commit",
        targetIdentity: sha,
        sha,
        relation: "created",
        method: "git_command",
        confidence: "slug_match_in_prose",
        evidence: JSON.stringify({
          toolIndex,
          command: cmd.slice(0, 100),
        }),
        observedAt: resolveRefObservedAt(committedAt, ctx.observedAt),
        committedAt,
        message: m[4].trim(),
        ...(branchName ? { branchName } : {}),
        extractorVersion: EXTRACTOR_VERSION,
        isPrimary: false,
        repoFullName: session.artifacts.repo ?? undefined,
      });
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
  if (GH_PR_CREATE_REGEX.test(strippedCmd)) {
    const flag = matchOutsideQuotes(cmd, GH_PR_HEAD_FLAG_RE, spans);
    const branch = flag?.[1] ?? flag?.[2] ?? flag?.[3];
    if (branch && !branch.startsWith("-")) {
      detected.push({
        branch,
        method: MonitoredSessionCliRefMethod.GhPrCreate,
      });
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
  if (GH_PR_CREATE_REGEX.test(strippedCmd)) {
    for (const text of outputTexts) {
      const match = text.match(GH_PR_BRANCH_OUTPUT_RE);
      if (match?.[1]) {
        detected.push({
          branch: match[1],
          method: MonitoredSessionCliRefMethod.GhPrCreate,
        });
      }
      const ghHead = createdPrHeadFromGhOutput(text);
      if (ghHead) {
        detected.push({
          branch: ghHead,
          method: MonitoredSessionCliRefMethod.GhPrCreate,
        });
      }
    }
  }

  // git commit summary line, e.g. "[feat/fea-1684 abc1234] message".
  if (GIT_COMMIT_CMD_RE.test(strippedCmd)) {
    for (const text of outputTexts) {
      const match = text.match(GIT_COMMIT_BRANCH_RE);
      if (match?.[1]) {
        detected.push({
          branch: match[1],
          method: MonitoredSessionCliRefMethod.GitCommit,
        });
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
      detected.push({
        branch,
        method: MonitoredSessionCliRefMethod.GitPush,
      });
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
  // Event time for both the branch refs and the slug refs below (ISS-5236).
  const eventTime = resolveRefObservedAt(tu.timestamp, ctx.observedAt);
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
        observedAt: eventTime,
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
  // FEA-3627: include sidecar sub-agent tool uses so a branch a sub-agent
  // pushed/created is attributed to the parent session.
  for (const { tu, toolIndex: i } of ctx.toolUses) {
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

// FEA-3128: extract PR refs from harness-authored pr-link records surfaced on
// NormalizedSession.prLinks. These rank above tool-text heuristics
// (harness_record > url_match in CONFIDENCE_RANK).
function extractHarnessPrLinkRefs(
  session: NormalizedSession,
  ctx: ExtractContext
): void {
  for (const pr of session.prLinks) {
    const prNumber = parsePullRequestNumber(pr.number);
    if (!(pr.url && prNumber !== null)) {
      continue;
    }
    let repo = pr.repo;
    if (!repo) {
      const m = new RegExp(GITHUB_PR_URL_RE.source).exec(pr.url);
      if (m) {
        repo = `${m[1]}/${m[2]}`;
      }
    }
    if (!repo) {
      continue;
    }
    ctx.refs.push({
      targetKind: "pull_request",
      targetIdentity: `${repo}#${prNumber}`,
      relation: "referenced",
      method: "harness_pr_link",
      confidence: "harness_record",
      evidence: JSON.stringify({
        source: "harness_pr_link",
        prUrl: pr.url,
      }),
      observedAt: ctx.observedAt,
      extractorVersion: EXTRACTOR_VERSION,
      isPrimary: false,
      repoFullName: repo,
      prNumber,
      prUrl: pr.url,
    });
  }
}

// Pass registry — runs in declared order; the order is load-bearing for the
// downstream dedup confidence-ranking and primary-method precedence.
const EXTRACTOR_PASSES: readonly ExtractorPass[] = [
  { name: "mcp_tool_call", run: extractMcpToolCallRefs },
  { name: "closedloop_url", run: extractClosedloopUrlRefs },
  { name: "bare_slug", run: extractBareSlugRefs },
  { name: "harness_pr_link", run: extractHarnessPrLinkRefs },
  { name: "pull_request", run: extractPullRequestRefs },
  { name: "workspace_context", run: extractWorkspaceContextRefs },
  { name: "commit", run: extractCommitRefs },
  { name: "branch", run: extractBranchRefs },
  // ISS-5764 + ISS-5763: prose mentions run LAST, and the position is REQUIRED,
  // not merely tidy. Two reasons:
  //  (a) Precedence. Every ref this pass mints is the weakest evidence in the
  //      file, so on the one dedup key it can share with an earlier pass
  //      (`pull_request|<repo>#<n>|referenced`) the confidence rank already
  //      makes the earlier record win; running last means a TIE — impossible
  //      today, since no other pass uses these tiers — would ALSO resolve in
  //      favour of the command-derived record, because `deduplicateRefs` keeps
  //      the first of an equal pair. It emits no `closedloop_artifact` refs, so
  //      unlike `bare_slug` its position cannot affect `selectPrimary`.
  //  (b) Repo resolution. A bare `#N` in prose carries no repo, and
  //      `artifacts.repo` is a CWD basename on most real sessions. The pass
  //      therefore resolves the owner/repo from the refs the earlier passes
  //      already proved (see `resolveSessionRepo`), which only works if
  //      `ctx.refs` is fully populated by the time it runs.
  {
    name: "prose_mention",
    run: (session, ctx) =>
      extractProseMentionRefs(session, ctx.toolUses, EXTRACTOR_VERSION, ctx),
  },
];

export function extractArtifactRefs(
  session: NormalizedSession,
  now?: string
): ArtifactRefRecord[] {
  const ctx: ExtractContext = {
    observedAt: resolveSessionObservedAt(session, now),
    refs: [],
    // ISS-5934: one walk of parent + sidecar tool uses for the whole extract.
    toolUses: collectSessionToolUses(session),
  };

  for (const pass of EXTRACTOR_PASSES) {
    pass.run(session, ctx);
  }

  attachMonitoredSessionActivity(session, ctx, EXTRACTOR_VERSION);
  return reconcileMonitoredSessionActivityRefs(ctx.refs);
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
