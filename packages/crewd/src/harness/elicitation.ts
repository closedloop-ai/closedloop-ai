/**
 * Elicitation detection for the harness cascade (FEA-4012).
 *
 * The audit/review passes run each harness NON-interactively (`claude --print`,
 * `codex exec`, `opencode run`) with stdin closed after the prompt — there is
 * no channel to answer a follow-up question. So when a harness, instead of
 * performing the audit, comes back by ASKING the operator for input (e.g. codex
 * replying "…then interview me to figure out what I need scheduled" or "Which
 * directory should I audit?"), it is effectively awaiting input that will never
 * arrive: the attempt makes no audit progress and the run would otherwise sit
 * (or exit "ok" with no findings) and hang the session.
 *
 * This helper classifies a harness attempt's output tail as an elicitation so
 * the cascade can treat it as a FAILED attempt that cascades to the next
 * harness — bounded progress, never a silent hang — rather than a live success.
 *
 * It is deliberately conservative in the correct direction: it fires ONLY on a
 * terminal waiting-for-input state — the last non-empty line of the tail is a
 * direct question to the operator (ends in `?`), or an explicit awaiting-input
 * marker ("waiting for your input", "let me know how you'd like to proceed").
 * Completion prose that merely happens to mention a question mid-sentence, or
 * politely offers further help ("Please let me know if you want anything else."
 * after a finished audit), is NOT an elicitation — the harness is done, not
 * blocked. This narrowing is why the guard is opt-in per caller (see
 * `CascadeOpts.rejectElicitation`): only the audit/review paths, whose sole job
 * is to produce a findings file, enable it. Custom tasks — which may legitimately
 * end by asking or drafting a question — leave it off.
 */

/**
 * Explicit terminal awaiting-input markers: phrases that, when they appear as
 * (or in) the LAST non-empty line, mean the harness has stopped and is blocked
 * on operator input rather than finishing its work. Matched case-insensitively.
 * Kept as module-level constants so Ultracite's `useTopLevelRegex` rule stays
 * satisfied and the set is easy to extend.
 */
const AWAITING_INPUT_MARKERS: readonly RegExp[] = [
  /\b(?:waiting|await(?:ing)?)\s+for\s+(?:your\s+)?(?:input|response|reply|answer|confirmation|approval|go[- ]ahead)\b/i,
  /\blet me know\s+(?:how|what|which|whether)\b/i,
  // Requests aimed squarely at the operator ("please advise", "please let me
  // know how you'd like to proceed") — NOT generic "please clarify X in the
  // README", which is finding prose about the code, not a question to answer.
  /\bplease\s+(?:advise|let me know\s+(?:how|what|which|whether))\b/i,
  /\bawaiting\s+(?:your\s+)?(?:input|instructions|confirmation|response)\b/i,
];

/**
 * Interview / "I'll ask you" framing that signals the harness intends to elicit
 * rather than audit, even without a trailing `?`. Narrow on purpose: it requires
 * an explicit interview/ask-you construction, not just the word "question".
 */
const INTERVIEW_MARKERS: readonly RegExp[] = [
  /\binterview\s+(?:me|you|the\s+user|the\s+operator)\b/i,
  /\b(?:i(?:'ll| will| am going to| would like to| need to)|let me|then)\s+(?:interview|ask)\s+(?:you|the\s+(?:user|operator))\b/i,
];

/** Trailing-output window (chars) an elicitation signal must appear within. */
const TAIL_WINDOW = 1500;

/** Split into non-empty, trimmed lines. */
function nonEmptyLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * True when `outputTail` looks like the harness ended by ELICITING input /
 * interviewing the operator instead of finishing its work.
 *
 * Requires a TERMINAL waiting-for-input state so completion prose is not
 * misclassified:
 *  1. the last non-empty line ends in `?` (a direct question to the operator), OR
 *  2. an explicit awaiting-input marker appears in the last non-empty line, OR
 *  3. an explicit interview ("I'll interview you", "then ask you") framing
 *     appears anywhere in the trailing window.
 *
 * Only the trailing {@link TAIL_WINDOW} characters are scanned, so a mid-run
 * mention does not trip the guard. Empty/whitespace-only output is not an
 * elicitation (that is an ordinary empty/failed attempt handled elsewhere).
 */
export function detectElicitation(outputTail: string): boolean {
  const trimmed = outputTail.trim();
  if (!trimmed) {
    return false;
  }
  const window = trimmed.slice(-TAIL_WINDOW);
  const lines = nonEmptyLines(window);
  const lastLine = lines.at(-1) ?? "";

  // 1. A direct question to the operator as the final line.
  if (lastLine.endsWith("?")) {
    return true;
  }
  // 2. An explicit awaiting-input marker on the final line.
  if (AWAITING_INPUT_MARKERS.some((re) => re.test(lastLine))) {
    return true;
  }
  // 3. Interview framing anywhere in the tail window (an intent to elicit even
  //    when phrased as a statement, e.g. "…then interview me to figure out …").
  return INTERVIEW_MARKERS.some((re) => re.test(window));
}
