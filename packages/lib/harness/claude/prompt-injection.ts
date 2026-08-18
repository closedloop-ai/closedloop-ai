/**
 * @file prompt-injection.ts
 * @description FEA-2641 / FEA-3595: classification of harness-injected `user`
 * entries that are NOT genuine human turns, plus the ScheduleWakeup
 * scheduled-prompt registry those injections are matched against.
 *
 * Extracted from `parse-claude.ts` (FEA-3595) so the composition root stays
 * under its size ceiling and this classification has one cohesive owner. Kept
 * structurally typed over `ScheduledPromptRegistry` rather than importing the
 * parser's `SessionAccumulator`, so the dependency runs one way only
 * (parse-claude → prompt-injection) with no cycle.
 */
import type { NormalizedToolUse } from "../types";

/**
 * FEA-2927: system-reminder blocks injected by the harness runtime (MCP
 * server instructions, deferred tool schemas, task reminders, auto-memory,
 * hook output). Multiline, non-greedy so multiple blocks are stripped
 * independently without swallowing human text between them.
 */
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/**
 * Marker prefix for local command OUTPUT echoed back under the `user` role.
 * Shared by isAutomatedPromptInjection (excludes it from human turns) and
 * isLocalCommandStdout (records it as a role:"system" message) so the two
 * classifications can never drift apart.
 */
const LOCAL_COMMAND_STDOUT_PREFIX = "<local-command-stdout>";

/** Prefix of a teammate message injected by agent-to-agent messaging. */
const TEAMMATE_MESSAGE_PREFIX = "Another Claude session sent a message:";

/**
 * FEA-2641: first-match extraction of the expanded slash-command XML the
 * harness injects for command turns, so a wake-up re-injection can be matched
 * back to its recorded ScheduleWakeup prompt. `<command-name>` content already
 * includes the leading slash; `<command-args>` may be empty.
 */
const COMMAND_NAME_TAG_RE = /<command-name>([^<]+)<\/command-name>/;
const COMMAND_ARGS_TAG_RE = /<command-args>([^<]*)<\/command-args>/;

/**
 * The `/loop` dynamic-pacing sentinel. `ScheduleWakeup` records this literal as
 * its `prompt`, but the runtime resolves it to the autonomous-loop instructions
 * at fire time — so the re-injected text never equals the recorded prompt and
 * no exact match can ever consume it. See {@link isAutomatedPromptInjection}.
 */
export const AUTONOMOUS_LOOP_SENTINEL = "<<autonomous-loop-dynamic>>";

/**
 * One recorded `ScheduleWakeup` firing awaiting its re-injection.
 *
 * `toolUse` is the SHARED `NormalizedToolUse` reference the parser pushed for
 * the originating call — the tool_result pass stamps `isError` onto that same
 * object later in the stream. Holding the reference (rather than a snapshot)
 * is what lets {@link consumeScheduledPrompt} gate on call success at consume
 * time: a ScheduleWakeup that failed, was canceled, or was rejected never
 * fires, so its prompt must never suppress a later genuine human turn
 * (FEA-3595 review).
 */
export type ScheduledPromptRegistration = {
  readonly prompt: string;
  readonly toolUse: NormalizedToolUse;
  consumed: boolean;
};

/**
 * The parser-accumulator slice this module owns. Structural on purpose — see
 * the file header for why this is not `SessionAccumulator`.
 */
export type ScheduledPromptRegistry = {
  readonly scheduledPrompts: ScheduledPromptRegistration[];
};

/**
 * FEA-3112 (semantic ruling: echoes are system messages): a
 * `<local-command-stdout>` entry is local command OUTPUT echoed back under the
 * `user` role — not human input, so it is excluded from human turns (via
 * isAutomatedPromptInjection). But it IS part of the transcript, so rather than
 * dropping it the parser records it as a role:"system" message (rendered as a
 * SystemMessage in the session-detail trace). This keeps the transcript
 * faithful while never crediting a human turn or inflating the
 * is_human/human_turns count (which counts only role:"human" over $.messages).
 */
export function isLocalCommandStdout(text: string): boolean {
  return text.trim().startsWith(LOCAL_COMMAND_STDOUT_PREFIX);
}

/**
 * FEA-2927: returns true when the text is composed entirely of
 * `<system-reminder>...</system-reminder>` blocks with no human-authored
 * content outside them. At least one block must have been present — empty
 * or whitespace-only input is NOT a system-reminder injection.
 */
function isSystemReminderOnly(text: string): boolean {
  const stripped = text.replace(SYSTEM_REMINDER_RE, "").trim();
  return stripped.length === 0 && text.trim().length > 0;
}

/**
 * FEA-2641: record one `ScheduleWakeup` firing so its later harness
 * re-injection as a `user` entry is excluded from human messages.
 *
 * Registrations are append-ordered and consumed one-per-firing, so N identical
 * recorded prompts suppress exactly N re-injections and no more.
 */
export function recordScheduledPrompt(
  registry: ScheduledPromptRegistry,
  prompt: string,
  toolUse: NormalizedToolUse
): void {
  registry.scheduledPrompts.push({ prompt, toolUse, consumed: false });
}

/**
 * FEA-2641: match-and-consume one pending scheduled-wakeup firing for `key`.
 * Consuming keeps the exclusion one-to-one with recorded firings, so a later
 * genuine typed prompt that happens to equal an already-fired wake-up prompt
 * still counts as human.
 *
 * FEA-3595: a registration whose originating call errored is never eligible —
 * a failed ScheduleWakeup schedules nothing, so consuming it would silently
 * drop the next real prompt.
 */
function consumeScheduledPrompt(
  registry: ScheduledPromptRegistry,
  key: string
): boolean {
  const match = registry.scheduledPrompts.find(
    (entry) =>
      !(entry.consumed || entry.toolUse.isError === true) &&
      entry.prompt === key
  );
  if (!match) {
    return false;
  }
  match.consumed = true;
  return true;
}

/**
 * FEA-2641: automated prompt injections are delivered as `user` entries with
 * NO distinguishing entry fields (no `isMeta`, no `origin`; `userType:
 * "external"` like a real prompt), so they are detectable only from the text
 * plus session context:
 *   - `<system-reminder>` blocks — harness-injected context (MCP server
 *     instructions, deferred tool schemas, task reminders, auto-memory,
 *     hook output). Infrastructure noise with no diagnostic value, so
 *     silently dropped (not recorded as role:"system"). FEA-2927.
 *   - ScheduleWakeup re-injections — when a scheduled wake-up fires, the
 *     harness re-injects the recorded prompt verbatim (plain text) or as
 *     expanded slash-command XML. Matched EXACTLY against prompts recorded
 *     from successful ScheduleWakeup tool uses; the reconstructed typed form
 *     is also tried with the leading slash stripped because older transcripts
 *     record the prompt without it. No fuzzy matching.
 *   - `<local-command-stdout>` echoes — local command OUTPUT, not input.
 *   - Teammate messages injected by agent-to-agent messaging.
 *
 * FEA-3595: the `/loop` autonomous sentinel resolves to different text at fire
 * time, so no exact form can match it and a fallback consumes a pending
 * sentinel registration instead. That fallback runs LAST, strictly after BOTH
 * exact forms (raw text and reconstructed slash-command) have failed —
 * otherwise a session with a sentinel AND a slash-command wake-up pending
 * would let the slash-command's expansion eat the sentinel, leaving the real
 * sentinel firing to be counted as a genuine human turn (i.e. reproducing the
 * very bug this fallback exists to fix).
 */
export function isAutomatedPromptInjection(
  registry: ScheduledPromptRegistry,
  text: string
): boolean {
  const trimmed = text.trim();
  if (
    isLocalCommandStdout(trimmed) ||
    trimmed.startsWith(TEAMMATE_MESSAGE_PREFIX) ||
    isSystemReminderOnly(trimmed)
  ) {
    return true;
  }
  if (registry.scheduledPrompts.length === 0) {
    return false;
  }
  if (consumeScheduledPrompt(registry, trimmed)) {
    return true;
  }
  if (consumeExactSlashCommandForm(registry, text)) {
    return true;
  }
  return consumeScheduledPrompt(registry, AUTONOMOUS_LOOP_SENTINEL);
}

/**
 * Reconstruct the typed slash-command form from the harness's expanded XML and
 * consume an exact match for it. Tried with the leading slash and again with it
 * stripped, because older transcripts record the prompt without it.
 */
function consumeExactSlashCommandForm(
  registry: ScheduledPromptRegistry,
  text: string
): boolean {
  const nameMatch = COMMAND_NAME_TAG_RE.exec(text);
  if (!nameMatch) {
    return false;
  }
  const name = nameMatch[1].trim();
  const argsMatch = COMMAND_ARGS_TAG_RE.exec(text);
  const args = argsMatch ? argsMatch[1].trim() : "";
  const typedForm = args ? `${name} ${args}` : name;
  return (
    consumeScheduledPrompt(registry, typedForm) ||
    (typedForm.startsWith("/") &&
      consumeScheduledPrompt(registry, typedForm.slice(1)))
  );
}
