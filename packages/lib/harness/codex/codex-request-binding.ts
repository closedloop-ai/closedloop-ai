/**
 * ISS-12552 (PRD-800 "Proving usage"): which Codex model request
 * issued each call, and which requests a usage record covers.
 *
 * Codex writes one top-level `token_usage_record` per request, naming its
 * `response_id`, after the calls that request issued and before the
 * `token_count` that accumulates its usage. Nothing in the rollout names a
 * call's request directly, so the binding is positional: a call belongs to the
 * next `token_usage_record` after it, a nested `McpToolCall` belongs to the
 * request of the one call still open around it, and a usage record covers the
 * requests recorded since the previous one. Where the position is ambiguous
 * (two calls open at once) the call names no request; it carries the requests
 * of the open calls as candidates instead (PRD-800, Daveth Oakhurst
 * 2026-10-20), which the allocation credits all to the call's write. A call
 * whose request record has no response id, or whose candidates pass the cap,
 * is marked `requestUnresolved`: the transcript recorded a request it cannot
 * name, so its write proves nothing (PRD-800 "Proving usage").
 */

import { MAX_CANDIDATE_REQUEST_KEYS } from "@repo/api/src/types/operation-claims";
import {
  TOKEN_SOURCE_IDENTITY_MAX_IDENTIFIERS,
  type TokenSourceIdentity,
  TokenSourceIdentityAvailability,
} from "@repo/api/src/types/token-cost-provenance";
import { requestKeyFor } from "../request-key";
import type { NormalizedToolUse } from "../types";
import { asStr, type Rec, type RolloutAccumulator } from "./codex-accumulator";

/** The source-identity scheme naming a Codex request by its response id. */
export const codexResponseIdScheme = "codex.response.id" as const;

/** A call that waits for the `token_usage_record` of the request it came from. */
export function awaitRequest(
  acc: RolloutAccumulator,
  toolUse: NormalizedToolUse
): void {
  acc.callsAwaitingRequest.push(toolUse);
}

/** Bind the waiting calls to this request and hold its id for the usage. */
export function recordTokenUsageRecord(acc: RolloutAccumulator, p: Rec): void {
  const payload = (p.payload ?? p) as Rec;
  const responseId = asStr(payload.response_id);
  if (!responseId) {
    for (const toolUse of acc.callsAwaitingRequest) {
      markUnresolved(toolUse);
    }
    acc.candidatesAwaitingRequest = acc.candidatesAwaitingRequest.filter(
      ({ outer, nested }) => {
        if (!acc.callsAwaitingRequest.includes(outer)) {
          return true;
        }
        markUnresolved(nested);
        return false;
      }
    );
    acc.callsAwaitingRequest = [];
    return;
  }
  const requestKey = requestKeyFor(codexResponseIdScheme, responseId);
  for (const toolUse of acc.callsAwaitingRequest) {
    toolUse.requestKey ??= requestKey;
  }
  acc.candidatesAwaitingRequest = acc.candidatesAwaitingRequest.filter(
    ({ outer, nested }) => {
      if (!acc.callsAwaitingRequest.includes(outer)) {
        return true;
      }
      addCandidate(nested, requestKey);
      return false;
    }
  );
  acc.callsAwaitingRequest = [];
  acc.responsesSinceUsage.push(responseId);
}

/**
 * A nested `McpToolCall` takes the request of the one call open around it, or
 * waits with that call when the call's request is not recorded yet.
 */
export function bindNestedCall(
  acc: RolloutAccumulator,
  nested: NormalizedToolUse
): void {
  const open = [...acc.toolCallIndex].filter(
    ([callId]) => !acc.completedCallIds.has(callId)
  );
  if (open.length > 1) {
    bindCandidates(acc, nested, open);
    return;
  }
  const [only] = open;
  if (only === undefined) {
    return;
  }
  const outer = acc.toolUses[only[1]];
  if (outer?.requestKey) {
    nested.requestKey = outer.requestKey;
  } else if (outer && acc.callsAwaitingRequest.includes(outer)) {
    acc.callsAwaitingRequest.push(nested);
  }
}

/**
 * The requests of every call open around an ambiguous nested call, now for
 * the recorded ones and later for those whose request is still ahead.
 */
function bindCandidates(
  acc: RolloutAccumulator,
  nested: NormalizedToolUse,
  open: readonly [string, number][]
): void {
  for (const [, index] of open) {
    const outer = acc.toolUses[index];
    if (outer?.requestKey) {
      addCandidate(nested, outer.requestKey);
    } else if (outer && acc.callsAwaitingRequest.includes(outer)) {
      acc.candidatesAwaitingRequest.push({ outer, nested });
    }
  }
}

function addCandidate(nested: NormalizedToolUse, requestKey: string): void {
  const candidates = nested.candidateRequestKeys ?? [];
  if (nested.requestUnresolved || candidates.includes(requestKey)) {
    return;
  }
  if (candidates.length >= MAX_CANDIDATE_REQUEST_KEYS) {
    markUnresolved(nested);
    return;
  }
  nested.candidateRequestKeys = [...candidates, requestKey].sort();
}

/** The call's request was recorded but cannot be named; it keeps no candidates. */
function markUnresolved(toolUse: NormalizedToolUse): void {
  if (toolUse.requestKey) {
    return;
  }
  toolUse.requestUnresolved = true;
  toolUse.candidateRequestKeys = undefined;
}

/** The identity of the requests a usage record covers; clears them. */
export function takeUsageIdentity(
  acc: RolloutAccumulator
): TokenSourceIdentity | undefined {
  const ids = [...new Set(acc.responsesSinceUsage)];
  acc.responsesSinceUsage = [];
  if (ids.length === 0 || ids.length > TOKEN_SOURCE_IDENTITY_MAX_IDENTIFIERS) {
    return;
  }
  return {
    availability: TokenSourceIdentityAvailability.Available,
    scheme: codexResponseIdScheme,
    sourceRecordIds: ids,
  };
}

/** Requests whose usage this parse does not record (replayed or zero). */
export function dropPendingUsage(acc: RolloutAccumulator): void {
  acc.responsesSinceUsage = [];
}
