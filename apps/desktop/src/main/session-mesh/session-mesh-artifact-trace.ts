import { sessionMeshLineageValidator } from "@repo/api/src/types/session-mesh";
import { redactSecrets } from "@repo/lib/security/redact-secrets";
import type { SessionMeshHookEvent } from "./session-mesh-hook-contract.js";
import {
  extractSessionMeshTicketSlugs,
  SESSION_MESH_SEND_MESSAGE_TOOL,
  sessionMeshObservedToolText,
} from "./session-mesh-send-message-relevance.js";

/**
 * What a session's trace says it is DOING, and to which artifact.
 *
 * Operator instruction, Marisol Ashgrove 2026-10-08: "we should instrument messages
 * at each meaningful artifact interaction that may be relevant; reviewing,
 * implementing, planning, found dependencies", then "symbols should come from
 * anything extracted from the session in it's trace" and "branch, PR, artifact".
 *
 * The gap that closes, measured on the live roster the same day: a session
 * reviewing a teammate's PR published `work_started` and `session_ended` and
 * nothing else, and both deliberately carry no symbols
 * (`sessionMeshLifecyclePublication`). `relevanceFor` therefore had no key to
 * place them by — not a slug, and not the PR, which nothing populated — so the
 * PR's author was delivered nothing.
 *
 * Three properties here are load-bearing rather than stylistic:
 *
 * - **The trace is mined, never the edited content.** Subjects come from the
 *   user prompt and from `sessionMeshObservedToolText`'s identifying fields.
 *   Content stays excluded for the reason that function already states: nearly
 *   every comment in this repo cites a ticket slug, so scanning it would make
 *   every session look like it was working on whatever it wrote a comment about.
 * - **A named subject is required.** An interaction naming no artifact returns
 *   no interaction, the same subject gate the `SendMessage` mirror uses and for
 *   the same reason: relevance routing cannot place it, so it would reach either
 *   nobody or everybody.
 * - **One spelling per subject.** A PR written as a URL, as `gh pr view N`, as
 *   `PR-N` or as `#N` normalizes to the single symbol `PR-N` and the single
 *   lineage value `#N`. The server matches both EXACTLY, so a second spelling on
 *   either side routes on one and matches on the other.
 */
const MAX_TRACE_TEXT = 20_000;
const MAX_SUBJECTS = 20;
/**
 * Claude Code's `UserPromptSubmit` payload field, read out of the shipped binary
 * rather than assumed (2.1.290: `hook_event_name:"UserPromptSubmit",prompt:r`).
 *
 * It is the only intent-bearing event a REVIEWING session produces: the Mesh's
 * `PreToolUse` matcher is `^(?:Edit|Write|MultiEdit|SendMessage)$`, and a review
 * reads without editing, so no tool event of its own ever reaches this runtime.
 */
const PROMPT_FIELD = "prompt";
/**
 * A PR URL names its own repository, and the number is only this checkout's PR
 * when that repository is the session's: the server compares `#N` alone, so a
 * foreign repository's PR would route to whoever is on this repository's `#N`.
 */
const PR_URL_PATTERN = /\b(github\.com\/[\w.-]+\/[\w.-]+)\/pull\/(\d{1,7})\b/gi;
/**
 * The verb is pinned and the number must follow it directly. A looser verb slot
 * let flags through: `gh pr list --limit 50` read as PR #50.
 */
const PR_COMMAND_PATTERN =
  /\bgh\s+pr\s+(?:view|checkout|diff|review|checks|comment|merge|edit)\s+#?(\d{1,7})\b/i;
const PR_SLUG_PATTERN = /\bPR-(\d{1,7})\b/i;
/**
 * `#8296` is how this repo's own prose cites a pull request. Two digits
 * minimum, because `#1` is as likely to be a heading level or a column index,
 * and a wrong PR routes the message to a stranger.
 */
const PR_HASH_PATTERN = /(?:^|[\s([,])#(\d{2,7})\b/;
const PR_PATTERNS = [
  PR_COMMAND_PATTERN,
  PR_SLUG_PATTERN,
  PR_HASH_PATTERN,
] as const;
/**
 * A UUID is only taken as an artifact id when an artifact-shaped path or
 * parameter introduces it. A bare UUID in a trace is far more often a session,
 * message or delivery id, and `relevanceFor` ranks artifact overlap, so a wrong
 * one manufactures a relationship between two unrelated sessions.
 */
const ARTIFACT_UUID_PATTERN =
  /\b(?:artifacts?|documents?|features?|issues?|plans?|prds?)[/=]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

export const SessionMeshArtifactInteraction = {
  DependencyFound: "dependency_found",
  Reviewing: "reviewing",
  Planning: "planning",
  Implementing: "implementing",
} as const;
export type SessionMeshArtifactInteraction =
  (typeof SessionMeshArtifactInteraction)[keyof typeof SessionMeshArtifactInteraction];

/**
 * Ordered, so precedence is explicit: a session that says it is implementing the
 * dependency it just found publishes the dependency, which is the fact a peer
 * cannot derive for themselves. `implementing` is last because its verbs are the
 * generic ones — it is what a trace means when it named an artifact and no more
 * specific phrase matched.
 */
const INTERACTION_PATTERNS: ReadonlyArray<
  readonly [SessionMeshArtifactInteraction, RegExp]
> = [
  [
    SessionMeshArtifactInteraction.DependencyFound,
    /\b(?:depends? on|dependency|dependencies|blocked by|prerequisite|prereq|is blocking|must land (?:first|before))\b/i,
  ],
  [
    SessionMeshArtifactInteraction.Reviewing,
    /\b(?:review(?:ing|ed|s)?|code.?review|visual.?qa|logical.?qa|design.?review|critique|vqa|address(?:ing)? (?:the )?(?:review )?comments)\b/i,
  ],
  [
    SessionMeshArtifactInteraction.Planning,
    /\b(?:plan(?:ning|ned|s)?|implementation plan|scope (?:out|the)|break (?:this |it )?down|decompose|design (?:the )?approach)\b/i,
  ],
  [
    SessionMeshArtifactInteraction.Implementing,
    /\b(?:implement(?:ing|ed|s)?|build(?:ing)?|fix(?:ing|ed)?|refactor(?:ing)?|writ(?:e|ing)|land(?:ing)?|ship(?:ping)?|work(?:ing)? on|pick(?:ing)? up)\b/i,
  ],
];

export type SessionMeshTraceSubjects = {
  /** Ticket and PR slugs, carried as workspace SYMBOLS. */
  symbols: string[];
  /** Canonical `#<number>`, the value `relevanceFor` compares for `samePullRequest`. */
  pullRequest?: string;
  /** ClosedLoop artifact UUIDs, the values `relevanceFor` overlaps as artifacts. */
  artifactIds: string[];
  /** What this trace says the session is doing, once it named a subject. */
  interaction: SessionMeshArtifactInteraction | null;
};

/**
 * The redacted, bounded text one hook event contributes to the session's trace.
 *
 * REDACTED FIRST, for the reason `extractSessionMeshSubjects` states: a subject
 * crosses from a session-private trace into an organization-wide row, and a
 * credential whose surrounding URL an extractor already stripped is no longer
 * recognizable to a later sanitizer.
 */
function traceText(event: SessionMeshHookEvent): string {
  const prompt = event.data[PROMPT_FIELD];
  const text = [
    typeof prompt === "string" ? prompt : "",
    sessionMeshObservedToolText(event.data.tool_name, event.data.tool_input),
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_TRACE_TEXT);
  return text ? redactSecrets(text) : "";
}

function classifyInteraction(
  text: string
): SessionMeshArtifactInteraction | null {
  for (const [interaction, pattern] of INTERACTION_PATTERNS) {
    if (pattern.test(text)) {
      return interaction;
    }
  }
  return null;
}

/**
 * The pull request a block of trace text names, as one canonical `#<number>`.
 *
 * Leading zeroes are normalized away because the server compares the string, so
 * `#0042` and `#42` would otherwise be two different pull requests.
 */
export function extractSessionMeshPullRequest(
  text: string,
  repository: string
): string | undefined {
  for (const [, urlRepository, digits] of text.matchAll(PR_URL_PATTERN)) {
    if (digits && urlRepository?.toLowerCase() === repository.toLowerCase()) {
      return `#${Number(digits)}`;
    }
  }
  for (const pattern of PR_PATTERNS) {
    const digits = pattern.exec(text)?.[1];
    if (digits) {
      return `#${Number(digits)}`;
    }
  }
  return undefined;
}

/**
 * The ClosedLoop artifact UUIDs a block of trace text names, deduplicated and
 * bounded.
 *
 * Each id is checked against the lineage validator it will be parsed by. The
 * pattern above accepts any 8-4-4-4-12 hex, the validator also checks the
 * version and variant nibbles, and a mismatch would throw on the hook path and
 * drop that event's presence and publications.
 */
export function extractSessionMeshArtifactUuids(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(ARTIFACT_UUID_PATTERN)]
        .map((match) => match[1]?.toLowerCase())
        .filter(
          (id): id is string =>
            Boolean(id) &&
            sessionMeshLineageValidator.safeParse({ artifactIds: [id] }).success
        )
    ),
  ].slice(0, MAX_SUBJECTS);
}

/**
 * Everything one hook event contributes to the session's routable identity: the
 * trace's ticket slugs, the pull request, the artifact ids, and the interaction
 * those subjects are the object of.
 *
 * A `SendMessage` event yields no interaction: `sessionMeshSendMessagePublication`
 * already owns that event and publishes the author's own recap, so classifying it
 * here as well would put two rows about one decision into every peer's inbox.
 */
export function sessionMeshTraceSubjects(
  event: SessionMeshHookEvent,
  repository: string
): SessionMeshTraceSubjects {
  const text = traceText(event);
  if (!text) {
    return { symbols: [], artifactIds: [], interaction: null };
  }
  const pullRequest = extractSessionMeshPullRequest(text, repository);
  const symbols = [
    ...new Set([
      ...extractSessionMeshTicketSlugs(text),
      ...(pullRequest ? [`PR-${pullRequest.slice(1)}`] : []),
    ]),
  ].slice(0, MAX_SUBJECTS);
  const artifactIds = extractSessionMeshArtifactUuids(text);
  const named = symbols.length > 0 || artifactIds.length > 0;
  const mirrored = event.data.tool_name === SESSION_MESH_SEND_MESSAGE_TOOL;
  return {
    symbols,
    artifactIds,
    interaction: named && !mirrored ? classifyInteraction(text) : null,
    ...(pullRequest ? { pullRequest } : {}),
  };
}
