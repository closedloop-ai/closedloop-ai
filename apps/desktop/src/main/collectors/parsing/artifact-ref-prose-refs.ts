/**
 * @file artifact-ref-prose-refs.ts
 * @description ISS-5764 + ISS-5763: recognize GitHub PR and branch references
 * that appear in assistant/human PROSE rather than in a `gh`/`git` command.
 *
 * Every pre-existing PR/branch recognizer in `artifact-ref-extractor.ts` is
 * anchored to a COMMAND (`gh pr create`, `gh pr view`, `git push`,
 * `git worktree add`, …). A session that merely *talks about* `#4682` — the
 * overwhelmingly common shape in an orchestrator's summary, a sub-agent's final
 * report, or a hand-off table — produced no ref at all. This module adds the
 * missing prose tier, mirroring the proven `extractBareSlugRefs` pattern that
 * already reads ClosedLoop slugs out of prose at `slug_match_in_prose`.
 *
 * Two invariants make this safe to add underneath the existing evidence:
 *
 *  1. **Relation is always `referenced`.** A session that MENTIONS a PR or a
 *     branch did not create, push, or review it. `created`/`workspace`/
 *     `reviewed` remain exclusively command-derived, so `deduplicateRefs`
 *     (keyed `targetKind|targetIdentity|relation`) never collides a prose
 *     mention with an authored record, and the cloud's
 *     `chooseStrongerSessionPrPurpose` keeps `Authored` on top.
 *  2. **Confidence ranks BELOW every command/URL/MCP tier.** On the one key a
 *     prose mention CAN collide with (`pull_request|<repo>#<n>|referenced`,
 *     also produced by the URL and harness-record passes), the stronger record
 *     wins outright.
 *
 * This module deliberately does NOT relax any command-shape gate. In
 * particular `stripQuotedContent` — which blanks quoted spans so
 * `echo "git push origin foo"` cannot register a branch push — stays exactly as
 * it is. Prose recognition is a separate, lower-confidence pass, not a looser
 * command gate.
 *
 * ## Adjacency, not proximity
 *
 * A bare `#123` proves nothing: on GitHub the same token addresses issues and
 * discussions. What makes it a PR reference is that the surrounding text is
 * TALKING ABOUT a PR. Adjacency is therefore resolved STRUCTURALLY, over two
 * scopes, because linear "within N characters" windows demonstrably fail the
 * highest-value real case — a markdown table whose only occurrence of "PR" is
 * the COLUMN HEADER, several rows and hundreds of characters away from the
 * numbers it scopes:
 *
 *  - **Block scope** — a run of consecutive non-blank lines (a paragraph, a
 *    bullet list, or a whole markdown table, none of which contain a blank
 *    line). If the block names the vocabulary anywhere, every candidate in the
 *    block is in scope. This covers same-sentence, immediately-preceding-token,
 *    reverse-order (`#4710 is the PR`), parenthetical (`ISS-5173 (#4403)`), and
 *    plural/paragraph (`15 PRs raised.` followed by a list) forms alike.
 *  - **Table column scope** — inside a markdown table, a header cell naming the
 *    vocabulary scopes ITS ENTIRE COLUMN, and nothing else. A table is scoped
 *    by column INSTEAD of by block precisely so a table carrying both an
 *    `Issue` column and a `PR` column does not leak issue numbers into the PR
 *    set. A body row that names the vocabulary in its own text is additionally
 *    scoped row-wide, so `| … | PR #4710 | … |` still resolves under a header
 *    that never says "PR".
 *
 * Where the vocabulary is genuinely absent, this module emits NOTHING. Recall
 * is not worth a fabricated link.
 */
import {
  ArtifactRefConfidence,
  ArtifactRefMethod,
} from "@repo/api/src/types/session-artifact-link";
import { DELEGATION_TOOL_NAMES } from "../../database/subagent-dedup.js";
import { isValidBranchName } from "../../enrichment/branch-validation.js";
import type { NormalizedSession } from "../types.js";
import { resolveRefObservedAt } from "./artifact-ref-observed-at.js";
import type { ArtifactRefRecord } from "./artifact-ref-record.js";
import { flattenTextValues, SHELL_TOOL_NAMES } from "./parser-utils.js";
import type { IndexedToolUse } from "./session-tool-uses.js";

/**
 * PR vocabulary. `PR`/`PRs`/`pull request`/`pull requests`, case-insensitive.
 * This is the disambiguator that turns a bare `#N` into a PR reference.
 */
const PR_VOCABULARY_RE = /\b(?:prs?|pull[\s-]*requests?)\b/i;

/**
 * Branch vocabulary. A branch name carries no sigil, so shape alone is not
 * evidence — `feat/x` is indistinguishable from a two-segment directory path.
 * A nearby branch verb/noun is required before any candidate is emitted.
 */
const BRANCH_VOCABULARY_RE =
  /\b(?:branch(?:es|ed|ing)?|worktrees?|push(?:ed|es|ing)?|checkout|checked[\s-]+out|rebas(?:e|ed|ing)|merged[\s-]+into)\b/i;

/**
 * A `#<digits>` token, optionally repo-qualified (`owner/repo#123`).
 *
 * The digit run is DELIBERATELY UNBOUNDED. A width cap (e.g. `\d{1,4}`) would
 * silently stop matching the day the repository's PR counter crosses it — the
 * bug is invisible because the pass simply returns fewer refs. The same
 * reasoning already governs `CLOSEDLOOP_SLUG_RE` in the extractor.
 */
const PROSE_PR_REF_RE = /(?:\b([\w.-]+\/[\w.-]+))?#(\d+)\b/g;

/** A full `owner/repo` slug — mirrors the extractor's `OWNER_REPO_SLUG_RE`. */
const OWNER_REPO_SLUG_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * Conventional branch namespaces. Requiring a known namespace (rather than
 * accepting any `<a>/<b>` token) is the primary false-positive control: without
 * it every two-segment directory path in prose reads as a branch. The repo's
 * own convention (`feat/*`, `fix/*`, `docs/*`, `refactor/*`, per AGENTS.md) is
 * the core; the rest are the conventional-commit style prefixes seen alongside.
 *
 * Accepted recall loss, stated deliberately: the `<user>/<slug>` branch form is
 * NOT recognized, because it is textually identical to a directory path
 * (`apps/desktop`) and no amount of surrounding vocabulary separates the two. A
 * fabricated branch is worse than a missing one.
 */
const BRANCH_NAMESPACE_ALTERNATION =
  "feat|feature|fix|bugfix|hotfix|chore|docs|refactor|perf|revert|release|spike";

/**
 * A namespace-prefixed branch candidate, captured with its leading delimiter so
 * a match cannot start mid-token. Inline-code backticks are ordinary delimiters
 * here — prose almost always writes a branch name as `` `feat/x` ``.
 *
 * The tail deliberately CONSUMES further `/` separators even though a branch is
 * then required to have exactly two segments. Stopping at the second segment
 * would truncate `docs/runbooks/merge-queue-operations` down to `docs/runbooks`
 * — a well-formed two-segment "branch" that never existed — instead of letting
 * the segment-count gate reject the path outright.
 *
 * NOT case-insensitive, and that is the single highest-value precision control
 * measured on the real corpus. Over 40 large local sessions the case-insensitive
 * form produced 294 distinct candidates of which exactly 6 were wrong, and ALL
 * SIX were prose "A-or-B" slash alternations wearing an upper/title-case
 * namespace: `FEAT/PRD`, `Feature/PRD`, `FEATURE/ISSUE`, `FEATURE/FeatureStatus`,
 * `Fix/rebut`, `DOCS/skill-docs`. Requiring the namespace to be lower-case — the
 * universal git convention, and this repo's documented one — removes every one
 * of them without touching a single true positive, since the SLUG half stays
 * case-permissive (`feature/FEA-1316` still resolves).
 */
const PROSE_BRANCH_CANDIDATE_RE = new RegExp(
  String.raw`(?:^|[\s(\[{'"\`,:>])((?:${BRANCH_NAMESPACE_ALTERNATION})\/[A-Za-z0-9][A-Za-z0-9._/-]*)`,
  "g"
);

/**
 * Trailing punctuation that is not part of the branch name. `/` is included so
 * a sentence-final `feat/x/` trims to a valid name rather than being discarded
 * by `isValidBranchName`'s trailing-slash rule.
 */
const TRAILING_PUNCTUATION_RE = /[./,;:!?)\]}'"`]+$/;

/** A file-extension suffix — proof the token is a path, not a branch. */
const FILE_EXTENSION_RE = /\.[A-Za-z0-9]{1,6}$/;

/**
 * A branch slug that was actually NAMED, rather than a bare English word.
 *
 * After the lower-case namespace rule, every residual false positive measured
 * on the real corpus was the same shape: a prose "A-or-B" alternation whose
 * right half is one plain word — `fix/rebut`, `fix/rerun`, `docs/design`,
 * `docs/guidance`, `refactor/hardening`, `refactor/thoroughness`,
 * `spike/research` — plus documentation placeholders (`feat/a`, `feat/b`,
 * `feature/x`) that appear in this repo's own source comments. Real branch
 * slugs carry a ticket id or a hyphenated description, so requiring a digit or
 * a hyphen removes 15 of the 17 remaining candidates and keeps every genuine
 * one (`fix/iss-5708-…`, `feature/FEA-1316`, `feat/repo-refresh`).
 *
 * The recall cost is explicit and accepted: a genuine one-word branch such as
 * `fix/typo` is not recognized FROM PROSE. It is still recognized in full from
 * any `git`/`gh` command, which is the stronger evidence anyway — this rule
 * only governs the weakest tier, where a fabricated branch is the worse error.
 */
const DESCRIBED_BRANCH_SLUG_RE = /[\d-]/;

/** Blank-line block separator. Applied AFTER CRLF normalization. */
const BLOCK_SEPARATOR_RE = /\n[ \t]*\n/;

/** Line break in either encoding — see `stripFencedBlocksKeepingInlineCode`. */
const CRLF_OR_LF_RE = /\r?\n/;

/** A markdown table's delimiter row: pipes, dashes, colons, whitespace only. */
const TABLE_DELIMITER_RE = /^[\s|:-]*-[\s|:-]*$/;

/** One leading and one trailing table pipe, stripped to align cell indices. */
const LEADING_PIPE_RE = /^\s*\|/;
const TRAILING_PIPE_RE = /\|\s*$/;

/**
 * A fenced code block opener/closer. Unlike the extractor's `stripCodeFences`,
 * this module keeps INLINE code spans: prose writes branch names and PR links
 * inside backticks far more often than not, and blanking them would drop most
 * genuine branch mentions. Fenced blocks are still removed — they are pasted
 * command/output transcripts, which are the command passes' territory.
 */
const FENCE_MARKER_RE = /^(`{3,})/;

/** Backtick characters, removed so an inline span reads as plain prose. */
const BACKTICK_RE = /`/g;

/**
 * `text` with fenced code blocks removed and inline-code backticks unwrapped.
 * An unterminated fence swallows everything after its opener (conservative,
 * matching `stripCodeFences`).
 */
export function stripFencedBlocksKeepingInlineCode(text: string): string {
  const out: string[] = [];
  let inFence = false;
  let marker = "";
  // Split on CRLF *or* LF and rejoin with LF. Transcripts are JSONL produced by
  // external harnesses and routinely carry pasted Windows content, so CRLF is
  // reachable at this parse boundary. Without normalizing here, the blank-line
  // block separator (`\n[ \t]*\n`) never matches `\r\n\r\n` — the stray `\r`
  // sits between the newlines — every block in the message merges into one, and
  // the whole precision story collapses: a single "PR" anywhere would put every
  // `#N` in the message in scope.
  for (const line of text.split(CRLF_OR_LF_RE)) {
    const trimmed = line.trimStart();
    if (inFence) {
      if (
        trimmed.startsWith(marker) &&
        trimmed.slice(marker.length).trim() === ""
      ) {
        inFence = false;
        marker = "";
      }
      continue;
    }
    const opener = trimmed.match(FENCE_MARKER_RE);
    if (opener) {
      inFence = true;
      marker = opener[1];
      continue;
    }
    out.push(line.replace(BACKTICK_RE, ""));
  }
  return out.join("\n");
}

/** A row's cells, with the optional outer pipes stripped so indices align. */
function tableRowCells(line: string): string[] {
  return line
    .replace(LEADING_PIPE_RE, "")
    .replace(TRAILING_PIPE_RE, "")
    .split("|");
}

/** True when `line` is a markdown table delimiter row (`|---|:--:|`). */
function isTableDelimiterRow(line: string): boolean {
  return line.includes("|") && TABLE_DELIMITER_RE.test(line.trim());
}

/**
 * Column-scoped fragments of a markdown table block: every cell sitting under a
 * header cell that names `vocabulary`, plus every row that names the vocabulary
 * in its own text. Returns an empty list when the block is not a table, so the
 * caller can fall back to block scope.
 */
function tableScopedFragments(
  blockLines: string[],
  vocabulary: RegExp
): string[] | null {
  const delimiterIndex = blockLines.findIndex(isTableDelimiterRow);
  if (delimiterIndex < 1) {
    return null;
  }
  const headerCells = tableRowCells(blockLines[delimiterIndex - 1]);
  const scopedColumns: number[] = [];
  for (let i = 0; i < headerCells.length; i++) {
    if (vocabulary.test(headerCells[i])) {
      scopedColumns.push(i);
    }
  }

  const fragments: string[] = [];
  let bodyEnd = delimiterIndex + 1;
  while (bodyEnd < blockLines.length && blockLines[bodyEnd].includes("|")) {
    const line = blockLines[bodyEnd];
    bodyEnd++;
    // A row that names the vocabulary itself is scoped row-wide, so
    // `| … | PR #4710 | … |` resolves even under a header that never says "PR".
    if (vocabulary.test(line)) {
      fragments.push(line);
      continue;
    }
    const cells = tableRowCells(line);
    for (const column of scopedColumns) {
      const cell = cells[column];
      if (cell !== undefined) {
        fragments.push(cell);
      }
    }
  }

  // Prose that merely SITS in the same block as a table is still prose, and is
  // still block-scoped. Without this, a table anywhere in the block silently
  // swallowed every line above its header — so `PR #4710 is the base.` followed
  // on the next line by an unrelated table lost the most basic adjacency form
  // there is, purely because of what came after it.
  const surroundingLines = [
    ...blockLines.slice(0, delimiterIndex - 1),
    ...blockLines.slice(bodyEnd),
  ];
  const surrounding = surroundingLines.join("\n");
  if (surrounding.trim().length > 0 && vocabulary.test(surrounding)) {
    fragments.push(surrounding);
  }
  return fragments;
}

/**
 * The non-empty prose blocks of `text`: fenced code removed, inline-code
 * backticks unwrapped, split on the blank-line block separator.
 *
 * ISS-5934: this is the ONE normalization per scanned text. Both vocabulary
 * scopers consume its result, because every entry the pass scans (each message,
 * each non-shell tool input, each delegation output, over the parent AND every
 * sidecar sub-agent) is looked at once for PR vocabulary and once for branch
 * vocabulary — and normalizing inside each scoper re-ran the line split, the
 * per-line `trimStart`, the fence match, the global backtick `replace`, and the
 * block split over the same text a second time.
 */
export function proseBlocks(text: string): string[] {
  const blocks: string[] = [];
  for (const block of stripFencedBlocksKeepingInlineCode(text).split(
    BLOCK_SEPARATOR_RE
  )) {
    if (block.trim().length > 0) {
      blocks.push(block);
    }
  }
  return blocks;
}

/**
 * The fragments of `blocks` that are in scope for `vocabulary` — the structural
 * adjacency rule documented at the top of this file. Table blocks are scoped by
 * COLUMN (and by self-naming row); every other block is scoped whole.
 *
 * Takes already-normalized blocks (`proseBlocks`) rather than raw text so the
 * two scopers a single entry runs through share one normalization.
 */
export function vocabularyScopedFragments(
  blocks: readonly string[],
  vocabulary: RegExp
): string[] {
  const fragments: string[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const tableFragments = tableScopedFragments(lines, vocabulary);
    if (tableFragments) {
      fragments.push(...tableFragments);
      continue;
    }
    if (vocabulary.test(block)) {
      fragments.push(block);
    }
  }
  return fragments;
}

/** A PR named in prose: its number, and its repo when the text qualified one. */
export type ProsePrMention = {
  prNumber: number;
  /** Present only when the text itself wrote `owner/repo#N`. */
  repoFullName?: string;
};

/**
 * PR numbers named in `blocks` adjacent to PR vocabulary, in first-seen order.
 * `blocks` are the already-normalized prose blocks of one scanned text
 * (`proseBlocks`) — this function does no normalization of its own.
 *
 * `#N` with no PR vocabulary in scope yields nothing — that is the whole point
 * of the pass, and the reason a bare issue/discussion `#N` cannot be
 * misreported as a pull request.
 */
export function findProsePrMentions(
  blocks: readonly string[]
): ProsePrMention[] {
  const seen = new Set<string>();
  const mentions: ProsePrMention[] = [];
  for (const fragment of vocabularyScopedFragments(blocks, PR_VOCABULARY_RE)) {
    for (const match of fragment.matchAll(PROSE_PR_REF_RE)) {
      const prNumber = Number.parseInt(match[2], 10);
      // Not a width cap: an unbounded digit run can exceed the safe-integer
      // range, and a lossy number is worse than no ref. `#0` is not a PR.
      if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
        continue;
      }
      const qualifier = match[1];
      const repoFullName =
        qualifier && OWNER_REPO_SLUG_RE.test(qualifier) ? qualifier : undefined;
      const key = `${repoFullName ?? ""}#${prNumber}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      mentions.push(repoFullName ? { prNumber, repoFullName } : { prNumber });
    }
  }
  return mentions;
}

/**
 * Branch names named in `blocks` adjacent to branch vocabulary, in first-seen
 * order. `blocks` are the already-normalized prose blocks of one scanned text
 * (`proseBlocks`) — this function does no normalization of its own. Precision
 * is preferred to recall throughout: a candidate must carry a conventional
 * namespace, be exactly two `/`-separated segments, carry no file extension,
 * and pass `isValidBranchName`.
 *
 * The two-segment rule is what separates `feat/iss-5764-prose-refs` (a branch)
 * from `docs/runbooks/merge-queue-operations` (a path) when both start with an
 * accepted namespace and neither carries an extension.
 */
export function findProseBranchNames(blocks: readonly string[]): string[] {
  const seen = new Set<string>();
  const branches: string[] = [];
  for (const fragment of vocabularyScopedFragments(
    blocks,
    BRANCH_VOCABULARY_RE
  )) {
    for (const match of fragment.matchAll(PROSE_BRANCH_CANDIDATE_RE)) {
      const candidate = match[1].replace(TRAILING_PUNCTUATION_RE, "");
      if (!isProseBranchCandidate(candidate)) {
        continue;
      }
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      branches.push(candidate);
    }
  }
  return branches;
}

/** The shape/validity gate every prose branch candidate must clear. */
function isProseBranchCandidate(candidate: string): boolean {
  const segments = candidate.split("/");
  if (segments.length !== 2) {
    return false;
  }
  if (!DESCRIBED_BRANCH_SLUG_RE.test(segments[1])) {
    return false;
  }
  if (FILE_EXTENSION_RE.test(candidate)) {
    return false;
  }
  if (!isValidBranchName(candidate)) {
    return false;
  }
  return true;
}

// --- The pass ---

/**
 * The subset of `ExtractContext` this pass writes to. Structurally compatible
 * with the extractor's own context; declared here so the import of the record
 * TYPE stays type-only and no runtime import cycle is created.
 */
export type ProseRefSink = {
  readonly observedAt: string;
  readonly refs: ArtifactRefRecord[];
};

/** A prose fragment to scan, with the provenance recorded on its refs. */
type ProseScanEntry = {
  text: string;
  timestamp: string | null | undefined;
  evidence: Record<string, unknown>;
};

/**
 * Every prose surface attributed to this session.
 *
 * Three sources, and the boundaries between them are deliberate:
 *
 *  1. `session.messages[]` — the session's own authored prose (both roles),
 *     exactly the surface `extractBareSlugRefs` already reads slugs from.
 *  2. NON-SHELL tool INPUT, over the parent's tool uses AND every sidecar
 *     sub-agent's. Shell tool inputs are excluded on purpose: a shell command
 *     is the COMMAND passes' territory, and re-reading it as prose would both
 *     duplicate their refs at a weaker tier and blur the line this change is
 *     explicitly not allowed to blur.
 *  3. DELEGATION tool OUTPUT (`Task`/`Agent`). A sub-agent's final report is
 *     assistant prose, and it reaches the parent ONLY here — a sidecar file
 *     carries the sub-agent's tool uses but no messages, so this is the single
 *     path by which a PR named only in a sub-agent's write-up becomes visible.
 *     Non-delegation tool OUTPUT is NOT scanned: it is machine content the
 *     session did not author, and a `#4682` inside a `Read` of some file is not
 *     a reference the session made.
 */
function collectProseEntries(
  session: NormalizedSession,
  toolUses: readonly IndexedToolUse[]
): ProseScanEntry[] {
  const entries: ProseScanEntry[] = [];
  for (let i = 0; i < session.messages.length; i++) {
    const msg = session.messages[i];
    if (msg.text) {
      entries.push({
        text: msg.text,
        timestamp: msg.timestamp,
        evidence: { messageIndex: i, role: msg.role },
      });
    }
  }

  for (const { tu, toolIndex, agentId } of toolUses) {
    const provenance = agentId ? { toolIndex, agentId } : { toolIndex };
    if (!SHELL_TOOL_NAMES.has(tu.name)) {
      for (const text of flattenTextValues(tu.input)) {
        entries.push({
          text,
          timestamp: tu.timestamp,
          evidence: { ...provenance, source: "tool_input" },
        });
      }
    }
    if (DELEGATION_TOOL_NAMES.has(tu.name)) {
      for (const text of flattenTextValues(tu.output)) {
        entries.push({
          text,
          timestamp: tu.timestamp,
          evidence: { ...provenance, source: "subagent_report" },
        });
      }
    }
  }
  return entries;
}

/**
 * ISS-5764 + ISS-5763: mint `referenced` PR and branch refs for names that
 * appear in prose, across the parent session and its sidecar sub-agents.
 *
 * Every ref this emits is `relation: "referenced"` at a confidence tier ranked
 * below every command-, URL-, MCP-, and harness-derived tier, so it can only
 * ever ADD a link the extractor previously had no evidence for — never
 * displace, downgrade, or re-label one it already had.
 */
export function extractProseMentionRefs(
  session: NormalizedSession,
  toolUses: readonly IndexedToolUse[],
  extractorVersion: number,
  sink: ProseRefSink
): void {
  // ONE resolution, shared by both kinds. A branch ref used to take
  // `artifacts.repo` raw, which is a CWD BASENAME on most real sessions — and
  // unlike a PR, a branch is never deferred on the cloud (`branch-links.ts`
  // always resolves or CREATES the artifact keyed by
  // `(organizationId, repositoryFullName, branchName)`), so a bare basename
  // would mint a permanent Branch artifact under a repo name that can never
  // reconcile. Prose is also the first recognizer that names branches the
  // session never operated on, so it is exactly the wrong place to guess.
  const sessionRepo = resolveSessionRepo(session, sink.refs);

  for (const entry of collectProseEntries(session, toolUses)) {
    const observedAt = resolveRefObservedAt(entry.timestamp, sink.observedAt);
    // ISS-5934: normalize once per entry, then hand the same blocks to both
    // vocabulary scopers.
    const blocks = proseBlocks(entry.text);
    for (const mention of findProsePrMentions(blocks)) {
      const repo = mention.repoFullName ?? sessionRepo;
      if (!repo) {
        continue;
      }
      sink.refs.push({
        targetKind: "pull_request",
        targetIdentity: `${repo}#${mention.prNumber}`,
        relation: "referenced",
        method: ArtifactRefMethod.PrMentionInProse,
        confidence: ArtifactRefConfidence.PrMentionInProse,
        evidence: JSON.stringify({
          ...entry.evidence,
          prNumber: mention.prNumber,
        }),
        observedAt,
        extractorVersion,
        isPrimary: false,
        repoFullName: repo,
        prNumber: mention.prNumber,
      });
    }
    for (const branchName of findProseBranchNames(blocks)) {
      sink.refs.push({
        targetKind: "branch",
        targetIdentity: branchName,
        branchName,
        relation: "referenced",
        method: ArtifactRefMethod.BranchMentionInProse,
        confidence: ArtifactRefConfidence.BranchMentionInProse,
        evidence: JSON.stringify({ ...entry.evidence, branchName }),
        observedAt,
        extractorVersion,
        isPrimary: false,
        ...(sessionRepo ? { repoFullName: sessionRepo } : {}),
      });
    }
  }
}

/**
 * The `owner/repo` a bare `#N` in this session's prose belongs to, or `null`
 * when the session gives no trustworthy answer.
 *
 * A bare `#N` carries no repo of its own, and a PR identity built on a
 * repo-less name can never reconcile with a real GitHub PR — the reason
 * `detectReviewedPrNumber` (FEA-3585) refuses to synthesize one. That posture
 * is preserved here, but the naive reading of it silently discards almost
 * everything: `session.artifacts.repo` is derived from the session CWD
 * (`path.basename`), so on a real local corpus it is the bare directory name
 * (`symphony-alpha`) rather than `owner/symphony-alpha` for the overwhelming
 * majority of sessions. Gating on it alone dropped 6,761 measured prose
 * mentions across 36 of 40 sampled sessions — the ticket's whole symptom,
 * reintroduced one layer down.
 *
 * So the session's OWN stronger evidence is consulted first, in descending
 * order of authority:
 *
 *  1. `artifacts.repo`, when the parser did resolve a full `owner/repo`.
 *  2. The repo already carried by a ref an EARLIER pass minted — a GitHub URL,
 *     a harness PR-link record, a `gh pr create` output. This is why the prose
 *     pass runs last: by then `refs` holds every repo the session proved it was
 *     working in.
 *  3. A harness-authored `prLinks` record.
 *
 * A declared BASENAME is not itself an answer, but it does rank the candidates:
 * one whose repo half matches the basename wins outright, and when none does,
 * the most-attested candidate wins only if it clears
 * {@link MIN_UNNAMED_REPO_ATTESTATIONS} — so a repo the session merely glanced
 * at cannot claim a session that never named it. A session that declared no
 * repo of its own has no basename to rank by, so its most-attested candidate
 * wins on frequency alone.
 *
 * With no answer from the three, no PR prose ref is minted at all and a prose
 * branch carries no repo.
 */
function resolveSessionRepo(
  session: NormalizedSession,
  refs: readonly ArtifactRefRecord[]
): string | null {
  const declared = session.artifacts.repo;
  if (declared && OWNER_REPO_SLUG_RE.test(declared)) {
    return declared;
  }

  const tally = new Map<string, number>();
  for (const ref of refs) {
    const repo = ref.repoFullName;
    if (repo && OWNER_REPO_SLUG_RE.test(repo)) {
      tally.set(repo, (tally.get(repo) ?? 0) + 1);
    }
  }
  for (const link of session.prLinks) {
    if (link.repo && OWNER_REPO_SLUG_RE.test(link.repo)) {
      tally.set(link.repo, (tally.get(link.repo) ?? 0) + 1);
    }
  }
  if (tally.size === 0) {
    return null;
  }

  // Candidates are ordered by a plain code-unit comparison, NOT `localeCompare`:
  // the tie-break must be a pure function of the input (golden dossiers are
  // compared byte-for-byte), and `localeCompare` is ICU/locale dependent, so a
  // dev machine, a CI container and a packaged Electron build could order the
  // same tie three different ways.
  const candidates = [...tally].sort(([a], [b]) => (a < b ? -1 : 1));

  // A bare `artifacts.repo` failed the full-slug test above, but it is still the
  // session's own CWD basename and it is the ONLY signal that distinguishes the
  // repo the session was working in from one it merely READ. Prefer a candidate
  // whose repo half matches it.
  //
  // Without this, one incidental `github.com/anthropics/claude-code/pull/…` URL
  // — routine for a session researching an upstream tool — outvotes nothing at
  // all and captures EVERY bare `#N` and every prose branch name in the session,
  // minting PR and Branch identities under a repository the org may not even
  // own. A single foreign URL is enough, because an exact tie then falls to the
  // byte-order tie-break, and `anthropics/…` sorts before `closedloop-ai/…`.
  if (declared) {
    const owned = candidates.find(
      ([repo]) => repoNameOf(repo) === declared.toLowerCase()
    );
    if (owned) {
      return owned[0];
    }
    // The basename named no candidate. It is EITHER a worktree/pool directory
    // whose session is genuinely working in the one repo it attested
    // (`west-monroe`, `lyon`, `atlanta`, `tmp`, `testuser5` — all real dossiers
    // in the frozen corpus, all working in `closedloop-ai/symphony-alpha`), OR
    // the session's own repo produced no ref at all and every candidate is one
    // it merely READ. The two are textually indistinguishable — a basename is
    // not a repo name, so nothing here can tell `west-monroe` from
    // `symphony-alpha`-alongside-a-foreign-candidate — so returning `null` on
    // the mismatch is NOT the answer: measured on the corpus it deletes 27
    // correct rows across three worktree dossiers to remove 1 wrong one.
    //
    // What IS separable is the reviewer's actual scenario: ONE incidental
    // upstream URL read mid-session. A repo the session only glanced at is
    // attested once; a repo it worked in is attested repeatedly. So a
    // single-attestation candidate cannot claim a session whose basename it
    // does not name.
    return bestAttestedCandidate(candidates, MIN_UNNAMED_REPO_ATTESTATIONS);
  }

  return bestAttestedCandidate(candidates, 1);
}

/**
 * The most-attested candidate, or `null` when even the best falls short of
 * `minCount`. Candidates arrive in code-unit order, so the first of an equal
 * pair wins and the result is a pure function of the input.
 */
function bestAttestedCandidate(
  candidates: readonly (readonly [string, number])[],
  minCount: number
): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [repo, count] of candidates) {
    if (count > bestCount) {
      best = repo;
      bestCount = count;
    }
  }
  return bestCount >= minCount ? best : null;
}

/**
 * How many times a candidate repo must be attested before it may claim a
 * session whose declared basename does NOT name it (ISS-5764 review, wongk).
 *
 * Two is the smallest value that separates the two shapes the frozen corpus
 * actually contains: a repo the session merely READ appears once (one upstream
 * PR URL), while a repo it worked in out of a worktree directory appears 4, 5,
 * 7 and 16 times across the corpus's worktree dossiers.
 *
 * Stated limit: this bounds the hazard, it does not erase it. A session that
 * reads several PRs of one upstream repo and attests its own repo nowhere can
 * still resolve to that upstream. Closing that needs a repo identity the
 * session did not have to prove by accident — a real remote, not a basename —
 * which this pass does not have.
 */
const MIN_UNNAMED_REPO_ATTESTATIONS = 2;

/** The repo half of an `owner/repo` slug, lower-cased for comparison. */
function repoNameOf(fullName: string): string {
  return fullName.slice(fullName.indexOf("/") + 1).toLowerCase();
}
