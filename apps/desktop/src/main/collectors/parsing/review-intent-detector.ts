/**
 * @file review-intent-detector.ts
 * @description FEA-2269 state-aware attribution (PRD-488): detect a user REQUEST
 * to PERFORM a review — a `/code-review`-style slash command / skill, or a
 * natural-language prompt like "code review my local changes". This is the
 * DECLARED signal that establishes the `review` phase in the stateful carry pass
 * ({@link ../activity-segment-classifier}).
 *
 * Distinct in INTENT from rework-detector's ADDRESS-review cue: "review my changes"
 * asks the agent to PERFORM a review (→ `review`), whereas "address the review
 * comments" asks it to FIX a prior review (→ `rework`). Conflating the two is
 * exactly what mislabeled pure code-review sessions as `rework`. The cues are not
 * textually disjoint, though — a compound prompt ("review my changes AND address the
 * review comments") can match both — so precedence is EXPLICIT: an address-review
 * (rework) prompt WINS (it carries the stricter ≥1-edit gate), and
 * `isReviewRequestPrompt` excludes it. A declined intent is likewise vetoed.
 *
 * Pure + deterministic: reads only `NormalizedSession` fields (no wall clock, no
 * randomness). Message text is inspected on-device with fixed cue regexes
 * (bounded deterministic matching — NOT the opt-in linguistic layer FEA-2274).
 */

import type { NormalizedSession } from "../types.js";
import { parseMsOrNull } from "./activity-segment-relabel.js";
import { isNegatedReviewIntent, isReviewFixPrompt } from "./rework-detector.js";

/** Splits a command / skill identifier into its words (`code-review:start`). */
const COMMAND_NAME_SEPARATOR_RE = /[^a-z0-9]+/;

/** A name word that IS the review noun. Token equality, so `preview` cannot match. */
const REVIEW_NAME_WORD_RE = /^reviews?$/;

/**
 * Leading verbs that take a review as their OBJECT — the command ACTS ON reviews
 * rather than performing one.
 *
 * This is the perform-vs-address precedence the PROMPT cues already encode
 * ({@link isReviewFixPrompt}), applied to names. The corpus shows why it is
 * needed: a skill named `apply-nightly-reviews` — which triages and resolves
 * bot-review PRs, i.e. rework — matched the old `/\breview/i` substring scan and
 * painted a 16.5-minute implement+validate arc as `review` at confidence 0.9,
 * with a declared layer behind which no declaration existed.
 */
const REVIEW_OBJECT_VERB_RE =
  /^(?:appl(?:y|ies)|address|fix|resolve|respond|reply|triage|handle|process|incorporate|action|implement|close|dismiss|merge)$/;

/**
 * True when a slash-command / skill NAME requests that a review be PERFORMED.
 *
 * Word-level rather than substring: `review` must appear as a whole word
 * (`code-review`, `security-review`, `review-pr`), and a name any of whose words
 * acts ON reviews is excluded. Substring scanning over arbitrary tool names is the
 * failure mode PLN-1490 names explicitly — a name is an identifier, not prose.
 *
 * The object verb is looked for at ANY position, not just the first. A namespaced
 * command puts its verb last (`code-review:fix`) exactly as readily as a flat one
 * puts it first (`fix-review-comments`), and both name an operation performed on a
 * review rather than a request to run one. Anchoring on the leading word alone
 * minted a fresh review transition for every namespaced fix command.
 */
export function isReviewRequestCommandName(name: string): boolean {
  const words = name
    .toLowerCase()
    .split(COMMAND_NAME_SEPARATOR_RE)
    .filter(Boolean);
  if (!words.some((word) => REVIEW_NAME_WORD_RE.test(word))) {
    return false;
  }
  return !words.some((word) => REVIEW_OBJECT_VERB_RE.test(word));
}

/**
 * A natural-language request to PERFORM a review: the `review` directive within a
 * few words of the user's own work object (my/the/this + optional recency
 * qualifier + changes/diff/code/PR/…). High-precision and deliberately narrow
 * (meant to grow with corpus evidence, not be exhaustive on day one):
 *   - matches "code review my local changes", "review the diff", "review my code",
 *     "do a code review of my changes", "please review this PR"
 *   - does NOT match the address-review shape "address the review comments"
 *     (the object there is `comments`/`feedback`, not a work object — that stays
 *     rework's cue) nor "preview …" (the leading `\b` guards it).
 */
export const REVIEW_REQUEST_PROMPT_CUE =
  /\b(?:code[-\s]?)?review(?:s|ing)?\b(?:\W+\w+){0,3}?\W+(?:my|the|this|these|our|your)\s+(?:local\s+|current\s+|recent\s+|staged\s+|uncommitted\s+|latest\s+|new\s+)?(?:changes?|diff|code|work|implementation|branch|commits?|edits?|pr|pull\s+request)\b/i;

/**
 * A request to perform a review where the review noun is the OBJECT of a run verb
 * and carries no work object of its own — "re-run the review", "do another code
 * review", "repeat that review".
 *
 * {@link REVIEW_REQUEST_PROMPT_CUE} cannot reach this shape: it requires a
 * possessive/article plus a work object AFTER `review`, and here there is nothing
 * after it. The corpus cost of the gap was total — in `b50de790` the human turn
 * "re-run the review; I now have more tokens" opened the session's only
 * SUCCESSFUL review execution, and all ~11 minutes of it carried no review label
 * at all.
 */
export const REVIEW_RERUN_PROMPT_CUE =
  /\b(?:re-?run|re-?do|repeat|restart|rerun|run|perform|do|start|kick\s+off)\b(?:\W+\w+){0,3}?\W+(?:the|that|this|another|a|one\s+more)\s+(?:code\s+)?reviews?\b/i;

/**
 * True when a human turn asks the agent to PERFORM a review of the user's work. A
 * DECLINED intent ("don't review my changes yet") is vetoed, and an ADDRESS-review
 * prompt takes precedence — a compound prompt that matches both cues is `rework`,
 * not a review request (rework carries the stricter ≥1-edit gate).
 */
export function isReviewRequestPrompt(text: string): boolean {
  if (isNegatedReviewIntent(text) || isReviewFixPrompt(text)) {
    return false;
  }
  return (
    REVIEW_REQUEST_PROMPT_CUE.test(text) || REVIEW_RERUN_PROMPT_CUE.test(text)
  );
}

/**
 * The sorted, unique epoch-ms at which a review was REQUESTED in the session —
 * a review-named slash command or skill, or a human prompt asking to perform a
 * review. These are the timestamps at which the stateful pass transitions the
 * current phase to `review`. Pure: every timestamp is parsed from session fields.
 *
 * MAIN-THREAD ONLY. A skill invoked inside a spawned subagent carries that
 * agent's `subagentId`, and it declares what the SUBAGENT was asked to do — which
 * is the subagent-purpose pass's business, not a phase transition for the parent.
 * The corpus makes the shape concrete: in `f216298d` two depth-1 reviewers each
 * invoke the review skill internally, and both landed as main-session request
 * instants. It was harmless there only because the parent was already reviewing;
 * in a session whose parent never requested one, a subagent's internal
 * declaration would flip the parent's phase outright.
 */
export function computeReviewRequestMs(session: NormalizedSession): number[] {
  const times = new Set<number>();
  // `?? []`: a legacy/partial session can deserialize a collection field as
  // undefined despite the required-array type — spreading/iterating it throws.
  for (const item of [
    ...(session.slashCommands ?? []),
    ...(session.skills ?? []),
  ]) {
    // Slash commands carry no subagent axis (they are user-typed on the main
    // thread by construction); skills do, and an absent id means main thread.
    if ("subagentId" in item && item.subagentId) {
      continue;
    }
    const ms = parseMsOrNull(item.timestamp);
    if (ms !== null && isReviewRequestCommandName(item.name)) {
      times.add(ms);
    }
  }
  for (const message of session.messages ?? []) {
    if (message.role !== "human") {
      continue;
    }
    const text = message.text?.trim();
    const ms = parseMsOrNull(message.timestamp);
    if (text && ms !== null && isReviewRequestPrompt(text)) {
      times.add(ms);
    }
  }
  return [...times].sort((a, b) => a - b);
}
