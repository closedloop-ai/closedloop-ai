import {
  type AgentComponentInvocationSyncAckState,
  type AgentComponentInvocationSyncPart,
  agentComponentInvocationGenerationHashPreimage,
  agentComponentInvocationSyncPartHashPreimage,
} from "@repo/api/src/types/agent-component-invocation";
import {
  agentComponentInvocationSyncBatchSchema,
  agentComponentInvocationSyncPartSchema,
} from "@repo/api/src/types/agent-component-invocation-schema";
import { z } from "zod";
import { sha256Hex } from "@/app/agent-sessions/service/component-invocation-helpers";
import { desktopAgentComponentInvocationsSyncService } from "@/app/desktop/agent-sessions/invocations/sync/service";
import { isRecord } from "@/lib/type-guards";
import { openSnapshot } from "../../perf-import-desktop-snapshot-reads";
import { type CorpusShiftTally, shiftCorpusIso } from "../core/corpus-shift";
import type { VibeSeedContext } from "../stage";
import {
  type DesktopSyncTarget,
  resolveDesktopSyncTargets,
} from "./sync-target";

/**
 * ISS-12017: replay the golden Desktop store's component-invocation outbox
 * through `desktopAgentComponentInvocationsSyncService`, the service behind
 * `POST /desktop/agent-sessions/invocations/sync`.
 *
 * The outbox already holds the exact parts the Desktop would post, built by its
 * own payload packer. Only their corpus timestamps move (by the run's corpus
 * shift, clamped at now), which changes the part's content, so its `partHash`
 * is recomputed with the shared preimage the server verifies.
 */

export const DESKTOP_INVOCATIONS_STAGE = "desktop-invocations";

const OUTBOX_SELECT = `
  SELECT payload AS "payload"
  FROM agent_component_invocation_sync_outbox
  ORDER BY external_session_id, external_generation_id, part_index
`;

const outboxRowSchema = z.object({ payload: z.string() });

/** Item fields that carry an instant on the wire. */
const ITEM_TIMESTAMP_FIELDS = [
  "invokedAt",
  "sourceModifiedAt",
  "capturedAt",
] as const;

export async function syncGoldenInvocations(
  context: VibeSeedContext
): Promise<void> {
  const targets = await resolveDesktopSyncTargets(
    context,
    DESKTOP_INVOCATIONS_STAGE
  );
  const [target] = targets;
  if (target === undefined) {
    throw new Error("the golden import put no session on any machine");
  }
  const payloads = readOutboxPayloads(target.storePath);
  if (payloads.length === 0) {
    throw new Error(
      "the Desktop store's invocation outbox is empty; nothing to sync"
    );
  }
  const tally: CorpusShiftTally = { clampedToNow: 0 };
  const states = new Map<AgentComponentInvocationSyncAckState, number>();
  let parts = 0;
  let items = 0;
  let unowned = 0;
  for (const generation of groupByGeneration(payloads)) {
    for (const part of shiftGeneration(generation, target, tally)) {
      // ISS-12135: a part syncs from the machine its session ran on.
      const owner = targets.find((candidate) =>
        candidate.externalSessionIds.has(part.externalSessionId)
      );
      if (owner === undefined) {
        unowned += 1;
        continue;
      }
      const state = await syncPart(owner, part);
      states.set(state, (states.get(state) ?? 0) + 1);
      parts += 1;
      items += part.items.length;
    }
  }
  const summary = [...states.entries()]
    .map(([state, count]) => `${count} ${state}`)
    .join(", ");
  target.log(
    `synced ${parts} invocation part(s) carrying ${items} item(s) (${summary}); ${unowned} part(s) for sessions no machine holds; ${tally.clampedToNow} timestamp(s) clamped to now`
  );
}

async function syncPart(
  target: DesktopSyncTarget,
  part: AgentComponentInvocationSyncPart
): Promise<AgentComponentInvocationSyncAckState> {
  const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
    protocolVersion: part.protocolVersion,
    parts: [part],
  });
  if (!parsed.success) {
    throw new Error(
      `invocation part ${part.externalSessionId}#${part.partIndex} fails the route's batch schema: ${parsed.error.message}`
    );
  }
  const [wirePart] = parsed.data.parts;
  if (!wirePart) {
    throw new Error("the invocation batch schema returned no part");
  }
  const result = await desktopAgentComponentInvocationsSyncService.sync({
    clerkUserId: target.clerkUserId,
    computeTargetId: target.computeTargetId,
    organizationId: target.organizationId,
    part: wirePart,
    userId: target.userId,
  });
  if (!result.ok) {
    throw new Error(`invocation sync refused the lane: ${result.error}`);
  }
  if (!result.value.accepted) {
    throw new Error(
      `invocation sync rejected part ${wirePart.externalSessionId}#${wirePart.partIndex}: ${result.value.reason}`
    );
  }
  return result.value.state;
}

/**
 * Shift one generation's parts. The generation id is the hash of the
 * generation's canonical items and each part hash covers its own items, so
 * both are recomputed from the PARSED parts, the values the server re-hashes.
 */
function shiftGeneration(
  payloads: readonly Record<string, unknown>[],
  target: DesktopSyncTarget,
  tally: CorpusShiftTally
): AgentComponentInvocationSyncPart[] {
  const parsed = payloads.map((payload) => {
    const items = Array.isArray(payload.items) ? payload.items : [];
    const shifted = agentComponentInvocationSyncPartSchema.safeParse({
      ...payload,
      sourceUpdatedAt: shiftCorpusIso(
        payload.sourceUpdatedAt,
        target.shift,
        tally
      ),
      items: items.map((item) => shiftItem(item, target, tally)),
    });
    if (!shifted.success) {
      throw new Error(
        `shifted invocation part ${String(payload.externalSessionId)}#${String(payload.partIndex)} is malformed: ${shifted.error.message}`
      );
    }
    return shifted.data;
  });
  const [first] = parsed;
  if (!first) {
    return [];
  }
  const externalGenerationId = sha256Hex(
    agentComponentInvocationGenerationHashPreimage({
      externalSessionId: first.externalSessionId,
      items: parsed.flatMap((part) => part.items),
    })
  );
  return parsed.map((part) => {
    const { partHash: _staleHash, ...rest } = part;
    const withoutHash = { ...rest, externalGenerationId };
    return {
      ...withoutHash,
      partHash: sha256Hex(
        agentComponentInvocationSyncPartHashPreimage(withoutHash)
      ),
    };
  });
}

/** Outbox parts grouped by generation, each group in part order. */
function groupByGeneration(
  payloads: readonly Record<string, unknown>[]
): Record<string, unknown>[][] {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const payload of payloads) {
    const key = `${String(payload.externalSessionId)}\u0000${String(payload.externalGenerationId)}`;
    const group = groups.get(key);
    if (group) {
      group.push(payload);
    } else {
      groups.set(key, [payload]);
    }
  }
  return [...groups.values()];
}

function shiftItem(
  item: unknown,
  target: DesktopSyncTarget,
  tally: CorpusShiftTally
): unknown {
  if (!isRecord(item)) {
    return item;
  }
  const shifted: Record<string, unknown> = { ...item };
  for (const field of ITEM_TIMESTAMP_FIELDS) {
    if (field in item) {
      shifted[field] = shiftCorpusIso(item[field], target.shift, tally);
    }
  }
  if (isRecord(item.anchor) && "timestamp" in item.anchor) {
    shifted.anchor = {
      ...item.anchor,
      timestamp: shiftCorpusIso(item.anchor.timestamp, target.shift, tally),
    };
  }
  return shifted;
}

function readOutboxPayloads(storePath: string): Record<string, unknown>[] {
  const db = openSnapshot(storePath);
  try {
    return z
      .array(outboxRowSchema)
      .parse(db.prepare(OUTBOX_SELECT).all())
      .map((row) => {
        const payload: unknown = JSON.parse(row.payload);
        if (!isRecord(payload)) {
          throw new Error("an invocation outbox payload is not a JSON object");
        }
        return payload;
      });
  } finally {
    db.close();
  }
}
