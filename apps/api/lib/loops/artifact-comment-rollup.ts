/**
 * Shared rollup of an artifact's comment threads into downstream agentic
 * context (FEA-4096). When an artifact (PRD / FEAT / PLAN / evergreen Document)
 * is serialized as agent input its body is included, but the comment threads —
 * which carry decisions, extra guidance, and open disagreement the agent must
 * respect — were historically dropped. This module renders those threads (the
 * `CommentThread`/`Comment` model landed by FEA-3950) into a single
 * "## Discussion & Decisions" markdown appendix that every artifact-injection
 * path in `loop-context-pack.ts` folds onto the artifact content.
 *
 * SSOT: this is the one renderer. Callers pass the org-scoped
 * `CommentThreadWithComments[]` from `commentsService.findThreadsByDocument`
 * (permission follows the artifact's scope) and append the result to the
 * artifact body BEFORE any untrusted-input wrapping, so the discussion lands
 * inside the untrusted boundary and is treated as data, not instructions.
 *
 * Thread shaping lets the agent weight influence:
 * - RESOLVED thread with a resolver = an authoritative resolved decision; treat
 *   like a body amendment.
 * - RESOLVED thread without a recorded resolver = agreed guidance refining the
 *   body.
 * - OPEN thread = open discord the agent must NOT silently resolve; surface the
 *   tension.
 */

import type {
  Comment,
  CommentThreadWithComments,
} from "@repo/api/src/types/comment";
import {
  DocumentThreadAnchorStatus,
  resolveAnchorStatusKernel,
  ThreadStatus,
} from "@repo/api/src/types/comment";
import type { BasicUser } from "@repo/api/src/types/user";

/**
 * How a rolled-up thread should be weighted by the downstream agent. Kept as a
 * const object (not a bare union) so callers and tests compare against members
 * rather than repeating string literals.
 */
export const ArtifactCommentRollupKind = {
  /** Resolved thread with a recorded resolver — authoritative, body-amendment. */
  ResolvedDecision: "resolved_decision",
  /** Resolved thread with no recorded resolver — agreed clarifying guidance. */
  Guidance: "guidance",
  /** Unresolved thread — open disagreement the agent must not silently close. */
  OpenDiscord: "open_discord",
} as const;
export type ArtifactCommentRollupKind =
  (typeof ArtifactCommentRollupKind)[keyof typeof ArtifactCommentRollupKind];

const ROLLUP_HEADING = "## Discussion & Decisions";

const ROLLUP_PREAMBLE =
  "The following are comment threads left by reviewers on this artifact. " +
  "Resolved decisions are authoritative and should be treated like amendments " +
  "to the body above. Guidance clarifies the body. Open discord is unresolved " +
  "disagreement — respect it, surface the tension, and do not silently resolve it.";

/**
 * Total rendered-byte ceiling for the appendix. Comment history is unbounded
 * user input, and the unsigned Desktop relay body has a hard ~1 MiB cap
 * (wongk review, FEA-4096); enough discussion could turn a previously valid
 * launch into a relay rejection. We stay well under the relay cap so the body
 * and other context also fit, and leave a truncation marker when we cut.
 */
const MAX_ROLLUP_BYTES = 64 * 1024;

const ROLLUP_TRUNCATION_MARKER =
  "\n\n_[Discussion truncated: too many/large comment threads to include in full.]_";

/**
 * Neutralize a single line of arbitrary user message text so it cannot forge
 * rollup control records. Message bodies are free-form user input, so a line
 * like `### Thread 9 — Resolved decision`, `- Resolved by: ...`, or
 * `END UNTRUSTED FEATURE` would otherwise inject a fake structural record the
 * downstream agent (or the untrusted-input wrapper) reads as a real one. We
 * prefix any line that opens with a Markdown/heading/list/fence/rule control
 * token with a visible backslash escape so the text is preserved verbatim as
 * data but no longer starts a structural construct.
 */
const CONTROL_LINE_PATTERN =
  /^(\s*)(#{1,6}\s|[-*+]\s|>|`{3,}|~{3,}|-{3,}|={3,}|_{3,})/;

const KIND_LABEL: Record<ArtifactCommentRollupKind, string> = {
  [ArtifactCommentRollupKind.ResolvedDecision]: "Resolved decision",
  [ArtifactCommentRollupKind.Guidance]: "Guidance (resolved)",
  [ArtifactCommentRollupKind.OpenDiscord]: "Open discord (unresolved)",
};

type RollupThread = {
  kind: ArtifactCommentRollupKind;
  /** Real inline-anchor context (snippet + status), or null for artifact-level threads. */
  anchorContext: string | null;
  /** Artifact version the thread was opened against, or null when unknown. */
  openedAtVersion: number | null;
  participants: string[];
  resolver: string | null;
  messages: Array<{ author: string; text: string }>;
};

/**
 * Classify a thread into a rollup kind (FEA-4096). Resolved + a recorded
 * resolver is an authoritative decision; resolved without a resolver is agreed
 * guidance; anything else (open) is unresolved discord.
 */
export function classifyRollupThread(
  thread: Pick<CommentThreadWithComments, "status" | "resolvedById">
): ArtifactCommentRollupKind {
  if (thread.status !== ThreadStatus.Resolved) {
    return ArtifactCommentRollupKind.OpenDiscord;
  }
  return thread.resolvedById
    ? ArtifactCommentRollupKind.ResolvedDecision
    : ArtifactCommentRollupKind.Guidance;
}

/**
 * Render the "## Discussion & Decisions" appendix for an artifact's threads, or
 * an empty string when there are no threads with surviving (non-deleted)
 * comments. Callers append the non-empty result to the artifact body before
 * untrusted-input wrapping.
 */
export function renderArtifactCommentRollup(
  threads: readonly CommentThreadWithComments[]
): string {
  const rollupThreads = threads
    .map(toRollupThread)
    .filter((thread): thread is RollupThread => thread !== null);

  if (rollupThreads.length === 0) {
    return "";
  }

  const header = `${ROLLUP_HEADING}\n\n${ROLLUP_PREAMBLE}\n\n`;
  return appendThreadsWithinBudget(header, rollupThreads);
}

/**
 * Append rendered thread sections under the header, stopping before the total
 * rendered bytes exceed MAX_ROLLUP_BYTES and leaving a truncation marker when
 * any thread is dropped. Byte length (not `.length`) is what the relay cap
 * measures, so we count UTF-8 bytes.
 */
function appendThreadsWithinBudget(
  header: string,
  rollupThreads: readonly RollupThread[]
): string {
  const budget = MAX_ROLLUP_BYTES - byteLength(ROLLUP_TRUNCATION_MARKER);
  let output = header;
  let truncated = false;

  for (let index = 0; index < rollupThreads.length; index++) {
    const section = renderRollupThread(rollupThreads[index], index + 1);
    const separator = index === 0 ? "" : "\n\n";
    const candidate = output + separator + section;
    if (byteLength(candidate) > budget) {
      truncated = true;
      break;
    }
    output = candidate;
  }

  return truncated ? output + ROLLUP_TRUNCATION_MARKER : output;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function toRollupThread(
  thread: CommentThreadWithComments
): RollupThread | null {
  const messages = thread.comments
    .filter((comment) => comment.deletedAt === null)
    .map((comment) => ({
      author: formatUser(comment.author ?? null, comment.authorId),
      text: extractCommentText(comment),
    }))
    .filter((message) => message.text.length > 0);

  if (messages.length === 0) {
    return null;
  }

  return {
    kind: classifyRollupThread(thread),
    anchorContext: describeAnchorContext(thread),
    openedAtVersion:
      typeof thread.createdAtVersion === "number"
        ? thread.createdAtVersion
        : null,
    participants: collectParticipants(thread),
    resolver: thread.resolvedBy
      ? formatUser(thread.resolvedBy, thread.resolvedById)
      : null,
    messages,
  };
}

function renderRollupThread(thread: RollupThread, position: number): string {
  const lines: string[] = [
    `### Thread ${position} — ${KIND_LABEL[thread.kind]}`,
  ];

  if (thread.anchorContext) {
    lines.push(`- Anchored to: ${thread.anchorContext}`);
  }
  if (thread.openedAtVersion !== null) {
    lines.push(`- Opened at version: v${thread.openedAtVersion}`);
  }
  if (thread.participants.length > 0) {
    lines.push(`- Participants: ${thread.participants.join(", ")}`);
  }
  if (
    thread.kind === ArtifactCommentRollupKind.ResolvedDecision &&
    thread.resolver
  ) {
    lines.push(`- Resolved by: ${thread.resolver}`);
  }

  lines.push("");
  for (const message of thread.messages) {
    lines.push(renderMessage(message));
  }

  return lines.join("\n");
}

/**
 * Render one message as a list item. The first line carries the author; every
 * line of the (arbitrary, multiline) user text is neutralized so it cannot
 * open a fake control record (see CONTROL_LINE_PATTERN) and continuation lines
 * are indented so they stay inside the message's list item rather than reading
 * as new top-level records.
 */
function renderMessage(message: { author: string; text: string }): string {
  const [firstLine, ...restLines] = message.text.split("\n");
  const rendered: string[] = [
    `- ${message.author}: ${neutralizeControlLine(firstLine ?? "")}`,
  ];
  for (const line of restLines) {
    rendered.push(`  ${neutralizeControlLine(line)}`);
  }
  return rendered.join("\n");
}

function neutralizeControlLine(line: string): string {
  return line.replace(
    CONTROL_LINE_PATTERN,
    (_match, indent: string, token: string) => `${indent}\\${token}`
  );
}

function collectParticipants(thread: CommentThreadWithComments): string[] {
  const seen = new Set<string>();
  const participants: string[] = [];
  for (const comment of thread.comments) {
    if (comment.deletedAt !== null) {
      continue;
    }
    const name = formatUser(comment.author ?? null, comment.authorId);
    if (!seen.has(name)) {
      seen.add(name);
      participants.push(name);
    }
  }
  return participants;
}

/**
 * Describe where an inline-anchored thread attaches. The anchored *text* itself
 * lives in the Liveblocks Yjs document, not the DB row, so we surface what the
 * projection carries: the legacy `anchorPreview` snippet when present and the
 * anchor status. Returns null for artifact-level threads with no anchor signal
 * — the opened-at version is a separate neutral field (wongk review, FEA-4096)
 * so a version alone does not render as a fake "Anchored to:" line.
 */
function describeAnchorContext(
  thread: CommentThreadWithComments
): string | null {
  const metadata = thread.metadata ?? {};
  const anchorPreview =
    typeof metadata.anchorPreview === "string" && metadata.anchorPreview.trim()
      ? metadata.anchorPreview.trim()
      : null;
  const anchorStatus = resolveAnchorStatusKernel({
    anchorStatus: metadata.anchorStatus,
    anchorPreview: metadata.anchorPreview,
  });

  const parts: string[] = [];
  if (anchorPreview) {
    parts.push(`"${anchorPreview}"`);
  }
  if (
    anchorStatus &&
    anchorStatus !== DocumentThreadAnchorStatus.ArtifactLevel
  ) {
    parts.push(`(${anchorStatus})`);
  }

  return parts.length > 0 ? parts.join(" ") : null;
}

function extractCommentText(comment: Comment): string {
  return typeof comment.plainText === "string" ? comment.plainText.trim() : "";
}

function formatUser(user: BasicUser | null, fallbackId: string | null): string {
  if (user) {
    const name = [user.firstName, user.lastName]
      .filter((part): part is string => Boolean(part))
      .join(" ")
      .trim();
    if (name) {
      return name;
    }
    if (user.email) {
      return user.email;
    }
  }
  return fallbackId ?? "Unknown participant";
}
