/**
 * @file ISS-7352 capture list F, JOIN-KEY half — the per-event keys that join
 * one of our rows back to Anthropic's own records and to each other.
 *
 * Item F has a second half, the per-SESSION identity block (`organization.id`,
 * `user.account_uuid`, …), which is NOT captured here because it is a different
 * GRAIN: it collapses to one row per session in `claude_code_session_identity`,
 * harvested by `claude-code-otel-identity.ts`. This module is deliberately named
 * for what it does carry, so a reader does not look here for that capture.
 *
 * The grain matters. Claude Code documents these four attributes as
 * events-only — their cardinality is unbounded, so they are never stamped on a
 * metric — which is why the four counter-backed tables in this lane do not
 * carry them and their absence there is the producer's design, not a gap.
 */

import {
  ClaudeCodeOtelAttributeKey,
  readString,
  withoutUndefinedValues,
} from "./claude-code-otel-attributes.js";
import type { ClaudeCodeEventCorrelation } from "./claude-code-otel-signal-contract.js";

/**
 * The per-event join keys a Claude Code log record carries.
 *
 * The return type is the CONTRACT's Zod-derived `ClaudeCodeEventCorrelation`,
 * not a hand-written twin: a fifth key added to `eventCorrelationSchema` must
 * fail typecheck HERE, in the reader that would otherwise keep returning four
 * and leave the new column NULL forever with nothing red.
 *
 * Absent keys stay ABSENT rather than becoming `null` — the persister maps
 * `undefined` to a NULL column itself, and an explicitly-present `null` would
 * defeat the `key in attributes` distinction the readers rely on elsewhere.
 */
export function eventCorrelationFrom(
  attributes: Record<string, unknown>
): ClaudeCodeEventCorrelation {
  // `satisfies` over EVERY key of the contract's type, not just the annotation:
  // an object literal missing a fifth optional key is still assignable to the
  // annotation, so only a total record makes the omission fail typecheck.
  return withoutUndefinedValues({
    promptId: readString(attributes, ClaudeCodeOtelAttributeKey.PromptId),
    messageUuid: readString(attributes, ClaudeCodeOtelAttributeKey.MessageUuid),
    workflowRunId: readString(
      attributes,
      ClaudeCodeOtelAttributeKey.WorkflowRunId
    ),
    workflowName: readString(
      attributes,
      ClaudeCodeOtelAttributeKey.WorkflowName
    ),
  } satisfies Record<
    keyof Required<ClaudeCodeEventCorrelation>,
    string | undefined
  >);
}

/**
 * The correlation columns of a row, as the persister writes them.
 *
 * Spread into BOTH the create and the update clause of every event-sourced
 * upsert, so a re-delivered export that now carries a `workflow.run_id` the
 * first delivery lacked fills the column in rather than leaving it NULL
 * forever.
 */
export function eventCorrelationColumns(
  event: ClaudeCodeEventCorrelation
): Record<keyof Required<ClaudeCodeEventCorrelation>, string | null> {
  return {
    promptId: event.promptId ?? null,
    messageUuid: event.messageUuid ?? null,
    workflowRunId: event.workflowRunId ?? null,
    workflowName: event.workflowName ?? null,
  };
}

/**
 * Whether two records that collided on a table's natural key agree on every
 * correlation key.
 *
 * The collision guards decide what a key collision MEANS: agreeing records
 * collapse SILENTLY as one observation reported twice, and disagreeing ones are
 * refused and counted in `unusable`. None of these four keys is in any natural
 * key, so without them in the comparison two records the producer proved
 * distinct — two prompts' work landing in one millisecond — collapse with
 * `unusable` reporting zero problems.
 */
export function sameEventCorrelation(
  first: ClaudeCodeEventCorrelation,
  second: ClaudeCodeEventCorrelation
): boolean {
  return (
    first.promptId === second.promptId &&
    first.messageUuid === second.messageUuid &&
    first.workflowRunId === second.workflowRunId &&
    first.workflowName === second.workflowName
  );
}
