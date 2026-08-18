/**
 * The LOCAL delivery decision for one complete invocation generation: build its
 * wire parts, or resolve the reason it can never be delivered at all.
 *
 * Originally extracted from `enqueueInvocationGeneration` (ISS-4976) so the
 * generation is dead-lettered locally on a limit or contract failure rather than
 * queued for five identical round trips that can only end in the same
 * dead-letter. Moved out of `component-invocations.ts` (ISS-5255) for the same
 * reason `component-invocation-sync-item.ts` was: that file is shrink-only, and
 * this decision is a pure function of the generation, so it is both cheaper to
 * own here and directly testable without a database. The DB writer keeps its
 * private visibility as a result.
 */

import {
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_ITEMS,
  type AgentComponentInvocationCompleteGeneration,
  type AgentComponentInvocationSyncPart,
} from "@repo/api/src/types/agent-component-invocation";
import { AgentComponentInvocationSyncLocalError } from "../agent-sync/agent-component-invocation-sync-constants.js";
import {
  AgentComponentInvocationSyncPayloadContractError,
  AgentComponentInvocationSyncPayloadLimitError,
  prepareAgentComponentInvocationSyncParts,
} from "../agent-sync/agent-component-invocation-sync-payload.js";

/** The wire parts for a deliverable generation, or the local reason it is not. */
export type InvocationSyncPartsBuild = {
  parts: AgentComponentInvocationSyncPart[];
  /* Narrowed to the declared reasons (wongk review on #4448): the value is
     persisted verbatim into the outbox `last_error` column, so a new branch
     returning an undeclared string must fail typecheck rather than land a
     reason no consumer maps. */
  localError: AgentComponentInvocationSyncLocalError | null;
  localErrorDetail: string | null;
};

/**
 * Build the wire parts for one complete generation, or resolve the LOCAL reason
 * it can never be delivered.
 */
export function buildInvocationSyncParts(
  generation: AgentComponentInvocationCompleteGeneration
): InvocationSyncPartsBuild {
  if (
    generation.items.length >
    AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_ITEMS
  ) {
    return {
      parts: [],
      localError:
        AgentComponentInvocationSyncLocalError.GenerationItemLimitExceeded,
      localErrorDetail: null,
    };
  }
  try {
    return {
      parts: prepareAgentComponentInvocationSyncParts(generation),
      localError: null,
      localErrorDetail: null,
    };
  } catch (error) {
    const localError = localInvocationSyncError(error);
    if (!localError) {
      throw error;
    }
    return {
      parts: [],
      localError,
      localErrorDetail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The local dead-letter reason for a build failure, or null to rethrow. */
function localInvocationSyncError(
  error: unknown
): AgentComponentInvocationSyncLocalError | null {
  if (error instanceof AgentComponentInvocationSyncPayloadContractError) {
    // The SHARED ingest boundary already rejected this part, so sending it could
    // only earn a 400 the client classes as permanent and the same dead-letter.
    return AgentComponentInvocationSyncLocalError.WirePayloadContractViolation;
  }
  if (error instanceof AgentComponentInvocationSyncPayloadLimitError) {
    return AgentComponentInvocationSyncLocalError.GenerationWireLimitExceeded;
  }
  return null;
}
