/**
 * ISS-9857: the trace rows for a session whose detail prefix was extended by
 * one or more event pages (`GET /agent-sessions/[id]/events` or the desktop's
 * IPC twin).
 *
 * Pages are NOT appended after `session.turnItems`. The producer's projection
 * already interleaves `metadata.messages` rows and one subagent row per
 * `session.agents` entry, whose timestamps run PAST the last prefix event — an
 * append would paint a t=150 tool row below a t=200 prompt and mint a fresh
 * subagent card per page. So the union of prefix + pages goes through the SAME
 * two projectors the producers ran (`@repo/lib/sessions`), once, with the same
 * metadata, agents, token usage and — on the desktop, which attributes cost to
 * the prefix even under truncation — the same cost points
 * (`AgentSessionDetail.tokenEventCostPoints`). The result is what the producer
 * would have served had its read never hit the ceiling.
 */

import type {
  AgentSessionDetail,
  SyncedAgentSessionEvent,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import { projectAgentSessionTurnItemsFromEvents } from "@repo/lib/sessions/agent-session-detail-projection";
import type { TranscriptActorContext } from "./transcript-turn-items";

/**
 * The actor identity the producer stamped on the prefix rows, so the union's
 * rows coalesce with — not beside — them.
 *
 * `sessionId` differs by producer (the desktop stamps `externalSessionId`, the
 * cloud `artifactId`) and `session-trace-groups.ts` coalesces on it, so it is
 * read off the rows rather than guessed per surface. The human name likewise:
 * the desktop labels a local session's author with its own placeholder, which
 * must not flip to the panel's derivation the moment a page lands. Either
 * falls back to the caller's value when the prefix carries no such row.
 */
export function resolveProjectedActorIdentity(
  turnItems: readonly TurnItem[] | undefined,
  fallback: { sessionId: string; humanName: string | null }
): { sessionId: string; humanName: string | null } {
  let sessionId: string | undefined;
  let humanName: string | null | undefined;
  for (const item of turnItems ?? []) {
    if (!("actor" in item)) {
      continue;
    }
    if (sessionId === undefined && item.actor.sessionId) {
      sessionId = item.actor.sessionId;
    }
    if (humanName === undefined && item.actor.human !== null) {
      humanName = item.actor.human;
    }
    if (sessionId !== undefined && humanName !== undefined) {
      break;
    }
  }
  return {
    sessionId: sessionId ?? fallback.sessionId,
    humanName: humanName ?? fallback.humanName,
  };
}

/**
 * Re-project prefix + pages as one stream.
 *
 * `eventsTruncated` is the caller's claim about the UNION, not the prefix: pass
 * `true` only while the last landed page still offers a `nextCursor`, and omit
 * it once the walk is exhausted, so a subagent's duration stops reading as cut
 * over a stream that is now whole.
 */
export function buildTurnItemsFromEventUnion(input: {
  session: AgentSessionDetail;
  pageEvents: readonly SyncedAgentSessionEvent[];
  context: TranscriptActorContext;
  eventsTruncated?: true;
}): TurnItem[] {
  const { session, pageEvents, context, eventsTruncated } = input;
  const identity = resolveProjectedActorIdentity(session.turnItems, {
    sessionId: session.id,
    humanName: context.humanActor.name,
  });
  const events = [...session.events, ...pageEvents];
  return projectAgentSessionTurnItemsFromEvents({
    sessionId: identity.sessionId,
    harness: context.harness,
    primaryModel: context.primaryModel,
    humanActor: { name: identity.humanName, color: context.humanActor.color },
    agents: session.agents,
    events,
    metadata: session.metadata,
    tokenUsageByModel: session.tokenUsageByModel,
    ...(session.tokenEventCostPoints
      ? { tokenEvents: session.tokenEventCostPoints }
      : {}),
    ...(eventsTruncated ? { eventsTruncated } : {}),
  });
}
