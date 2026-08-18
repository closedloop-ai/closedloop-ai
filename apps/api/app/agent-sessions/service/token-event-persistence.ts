import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import {
  TokenCostBasis,
  type TokenCostLane,
} from "@repo/api/src/types/token-cost-provenance";
import { TokenEventTransportIdentityCollisionError } from "@/lib/desktop-agent-sessions-errors";
import { roundCost } from "./coercion";
import type { AgentSessionUpsertTx } from "./records";

const TOKEN_EVENT_WRITE_CHUNK_SIZE = 500;

type TokenEvent = NonNullable<SyncedAgentSession["tokenEvents"]>[number];

/**
 * Persists provider-neutral token provenance and additive cost evidence.
 * Transport identity is the only replay key: exact immutable replays are
 * idempotent, while conflicting content fails the surrounding transaction.
 */
export async function persistSessionTokenEvents(
  tx: AgentSessionUpsertTx,
  artifactId: string,
  organizationId: string,
  session: SyncedAgentSession,
  shouldUpdateMutableEvidence: boolean
): Promise<void> {
  const tokenEvents = dedupeTokenEvents(session.tokenEvents ?? []);
  if (tokenEvents.length === 0) {
    return;
  }

  for (
    let start = 0;
    start < tokenEvents.length;
    start += TOKEN_EVENT_WRITE_CHUNK_SIZE
  ) {
    const chunk = tokenEvents.slice(
      start,
      start + TOKEN_EVENT_WRITE_CHUNK_SIZE
    );
    await tx.agentSessionTokenEvent.createMany({
      data: chunk.map((event) => ({
        agentSessionId: artifactId,
        externalEventId: event.externalEventId,
        agentExternalId: event.agentExternalId ?? null,
        model: event.model,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheWriteTokens: event.cacheWriteTokens,
        eventCreatedAt: new Date(event.createdAt),
        ...toInitialEvidence(event),
      })),
      skipDuplicates: true,
    });

    // Verify each bounded insert so a concurrent winner on the unique transport
    // key cannot be silently accepted with different immutable content.
    await assertPersistedImmutableContent(
      tx,
      artifactId,
      organizationId,
      chunk
    );
  }

  if (!shouldUpdateMutableEvidence) {
    return;
  }
  await updateSourceIdentity(
    tx,
    artifactId,
    organizationId,
    tokenEvents.filter((event) => event.sourceIdentity !== undefined)
  );
  await updateCostEvidence(
    tx,
    artifactId,
    organizationId,
    tokenEvents.filter(
      (event) =>
        event.costSummary !== undefined || event.estimatedCostUsd !== undefined
    )
  );
}

/** Maps validated cost evidence without coercing omission to zero. */
export function toTokenEventCostEvidence(event: TokenEvent): {
  estimatedCost: number | null;
  costCompleteness: string | null;
  costCompletenessReason: string | null;
  subscriptionEquivalentCost: number | null;
  apiEstimatedCost: number | null;
} {
  const summary = event.costSummary;
  if (summary === undefined) {
    return {
      estimatedCost:
        event.estimatedCostUsd === undefined
          ? null
          : roundCost(event.estimatedCostUsd),
      costCompleteness: null,
      costCompletenessReason: null,
      subscriptionEquivalentCost: null,
      apiEstimatedCost: null,
    };
  }

  const lanes = "lanes" in summary ? summary.lanes : undefined;
  const estimatedCost =
    "subtotalUsd" in summary ? roundCost(summary.subtotalUsd) : null;
  const laneCosts = quantizeLaneCosts(lanes, estimatedCost);
  return {
    estimatedCost,
    costCompleteness: summary.completeness,
    costCompletenessReason: "reason" in summary ? summary.reason : null,
    subscriptionEquivalentCost: laneCosts.subscriptionEquivalent,
    apiEstimatedCost: laneCosts.apiEstimated,
  };
}

function dedupeTokenEvents(events: readonly TokenEvent[]): TokenEvent[] {
  const byTransportId = new Map<string, TokenEvent>();
  for (const event of events) {
    const previous = byTransportId.get(event.externalEventId);
    if (previous && !hasSameImmutableContent(previous, event)) {
      throw new TokenEventTransportIdentityCollisionError();
    }
    // Supplied mutable evidence remains last-wins, but omission never erases an
    // earlier duplicate's evidence inside the same payload.
    byTransportId.set(
      event.externalEventId,
      previous ? mergeMutableEvidence(previous, event) : event
    );
  }
  return [...byTransportId.values()];
}

function toInitialEvidence(event: TokenEvent) {
  const costEvidence = toTokenEventCostEvidence(event);
  return {
    ...costEvidence,
    ...(event.sourceIdentity === undefined
      ? {}
      : { sourceIdentity: event.sourceIdentity }),
  };
}

async function assertPersistedImmutableContent(
  tx: AgentSessionUpsertTx,
  artifactId: string,
  organizationId: string,
  events: readonly TokenEvent[]
): Promise<void> {
  const persisted = await tx.agentSessionTokenEvent.findMany({
    where: {
      agentSessionId: artifactId,
      externalEventId: { in: events.map((event) => event.externalEventId) },
      session: { artifact: { organizationId } },
    },
    select: {
      externalEventId: true,
      agentExternalId: true,
      model: true,
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheWriteTokens: true,
      eventCreatedAt: true,
    },
  });
  const byTransportId = new Map(
    persisted.map((event) => [event.externalEventId, event])
  );
  for (const event of events) {
    const stored = byTransportId.get(event.externalEventId);
    if (
      !stored ||
      stored.agentExternalId !== (event.agentExternalId ?? null) ||
      stored.model !== event.model ||
      stored.inputTokens !== BigInt(event.inputTokens) ||
      stored.outputTokens !== BigInt(event.outputTokens) ||
      stored.cacheReadTokens !== BigInt(event.cacheReadTokens) ||
      stored.cacheWriteTokens !== BigInt(event.cacheWriteTokens) ||
      stored.eventCreatedAt.getTime() !== new Date(event.createdAt).getTime()
    ) {
      throw new TokenEventTransportIdentityCollisionError();
    }
  }
}

async function updateSourceIdentity(
  tx: AgentSessionUpsertTx,
  artifactId: string,
  organizationId: string,
  events: readonly TokenEvent[]
): Promise<void> {
  for (
    let start = 0;
    start < events.length;
    start += TOKEN_EVENT_WRITE_CHUNK_SIZE
  ) {
    const chunk = events.slice(start, start + TOKEN_EVENT_WRITE_CHUNK_SIZE);
    const values = chunk
      .map((_, index) => {
        const base = index * 2 + 2;
        return `($${base}::text, $${base + 1}::jsonb)`;
      })
      .join(", ");
    const orgParam = chunk.length * 2 + 2;
    await tx.$executeRawUnsafe(
      `UPDATE agent_session_token_events AS t
          SET source_identity = v.source_identity
         FROM (VALUES ${values}) AS v(external_event_id, source_identity)
        WHERE t.agent_session_id = $1::uuid
          AND t.external_event_id = v.external_event_id
          AND t.source_identity IS DISTINCT FROM v.source_identity
          AND EXISTS (
            SELECT 1 FROM artifacts
             WHERE artifacts.id = $1::uuid
               AND artifacts.organization_id = $${orgParam}::uuid
          )`,
      artifactId,
      ...chunk.flatMap((event) => [
        event.externalEventId,
        JSON.stringify(event.sourceIdentity),
      ]),
      organizationId
    );
  }
}

async function updateCostEvidence(
  tx: AgentSessionUpsertTx,
  artifactId: string,
  organizationId: string,
  events: readonly TokenEvent[]
): Promise<void> {
  for (
    let start = 0;
    start < events.length;
    start += TOKEN_EVENT_WRITE_CHUNK_SIZE
  ) {
    const chunk = events.slice(start, start + TOKEN_EVENT_WRITE_CHUNK_SIZE);
    const values = chunk
      .map((_, index) => {
        const base = index * 7 + 2;
        return `($${base}::text, $${base + 1}::numeric, $${base + 2}::text, $${base + 3}::text, $${base + 4}::numeric, $${base + 5}::numeric, $${base + 6}::boolean)`;
      })
      .join(", ");
    const orgParam = chunk.length * 7 + 2;
    await tx.$executeRawUnsafe(
      `UPDATE agent_session_token_events AS t
          SET estimated_cost = CASE
                WHEN v.has_summary OR t.cost_completeness IS NULL THEN v.estimated_cost
                ELSE t.estimated_cost
              END,
              cost_completeness = CASE WHEN v.has_summary THEN v.cost_completeness ELSE t.cost_completeness END,
              cost_completeness_reason = CASE WHEN v.has_summary THEN v.cost_completeness_reason ELSE t.cost_completeness_reason END,
              subscription_equivalent_cost = CASE WHEN v.has_summary THEN v.subscription_equivalent_cost ELSE t.subscription_equivalent_cost END,
              api_estimated_cost = CASE WHEN v.has_summary THEN v.api_estimated_cost ELSE t.api_estimated_cost END
         FROM (VALUES ${values}) AS v(
           external_event_id,
           estimated_cost,
           cost_completeness,
           cost_completeness_reason,
           subscription_equivalent_cost,
           api_estimated_cost,
           has_summary
         )
        WHERE t.agent_session_id = $1::uuid
          AND t.external_event_id = v.external_event_id
          AND (
            (
              (v.has_summary OR t.cost_completeness IS NULL)
              AND t.estimated_cost IS DISTINCT FROM v.estimated_cost
            )
            OR (
              v.has_summary
              AND (
                t.cost_completeness IS DISTINCT FROM v.cost_completeness
                OR t.cost_completeness_reason IS DISTINCT FROM v.cost_completeness_reason
                OR t.subscription_equivalent_cost IS DISTINCT FROM v.subscription_equivalent_cost
                OR t.api_estimated_cost IS DISTINCT FROM v.api_estimated_cost
              )
            )
          )
          AND EXISTS (
            SELECT 1 FROM artifacts
             WHERE artifacts.id = $1::uuid
               AND artifacts.organization_id = $${orgParam}::uuid
          )`,
      artifactId,
      ...chunk.flatMap((event) => {
        const evidence = toTokenEventCostEvidence(event);
        return [
          event.externalEventId,
          evidence.estimatedCost,
          evidence.costCompleteness,
          evidence.costCompletenessReason,
          evidence.subscriptionEquivalentCost,
          evidence.apiEstimatedCost,
          event.costSummary !== undefined,
        ];
      }),
      organizationId
    );
  }
}

function hasSameImmutableContent(left: TokenEvent, right: TokenEvent): boolean {
  return (
    (left.agentExternalId ?? null) === (right.agentExternalId ?? null) &&
    left.model === right.model &&
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens &&
    new Date(left.createdAt).getTime() === new Date(right.createdAt).getTime()
  );
}

function mergeMutableEvidence(
  previous: TokenEvent,
  current: TokenEvent
): TokenEvent {
  return {
    ...current,
    ...(current.estimatedCostUsd === undefined &&
    previous.estimatedCostUsd !== undefined
      ? { estimatedCostUsd: previous.estimatedCostUsd }
      : {}),
    ...(current.sourceIdentity === undefined &&
    previous.sourceIdentity !== undefined
      ? { sourceIdentity: previous.sourceIdentity }
      : {}),
    ...(current.costSummary === undefined && previous.costSummary !== undefined
      ? { costSummary: previous.costSummary }
      : {}),
  };
}

function quantizeLaneCosts(
  lanes: readonly TokenCostLane[] | undefined,
  estimatedCost: number | null
): {
  subscriptionEquivalent: number | null;
  apiEstimated: number | null;
} {
  if (!(lanes && estimatedCost !== null)) {
    return { subscriptionEquivalent: null, apiEstimated: null };
  }
  const byBasis = new Map<
    (typeof TokenCostBasis)[keyof typeof TokenCostBasis],
    number
  >();
  let assigned = 0;
  for (const [index, lane] of lanes.entries()) {
    const isLast = index === lanes.length - 1;
    const quantized = isLast
      ? roundCost(estimatedCost - assigned)
      : roundCost(lane.subtotalUsd);
    byBasis.set(lane.basis, quantized);
    assigned = roundCost(assigned + quantized);
  }
  return {
    subscriptionEquivalent:
      byBasis.get(TokenCostBasis.SubscriptionEquivalent) ?? null,
    apiEstimated: byBasis.get(TokenCostBasis.ApiEstimated) ?? null,
  };
}
