import {
  deriveTurnTimestamps,
  isForkReplayedMessage,
  MAX_METADATA_HUMAN_TURN_TIMESTAMPS,
} from "./human-turn-timestamps";

/**
 * ISS-9864: the ONE legacy agent-turn unit list, shared by the desktop bucket
 * derivation and the cloud sync producer — the agent-side twin of
 * `./human-turn-timestamps`.
 *
 * A session that synced NO round-trip series (the Codex OTel writer, pre-FEA-2730
 * rows) gets its Agent cells from `$.messages` on both surfaces. Both sync lanes
 * cap `$.messages` at `MAX_METADATA_MESSAGES` (100) before the payload leaves the
 * machine, so the cloud's legacy arm could never count message 101+, and the
 * desktop sliced its own UNTRUNCATED store to the same window (ISS-8259) so it
 * never reported MORE than the cloud — two surfaces agreeing on an undercount.
 * ISS-7896 ruling A reserved that cloud arm's raw `$.messages` reading; the
 * ISS-9864 ruling (Tamsin, 2026-09-14) amends it for exactly this change: the
 * arm may read a derived, bounded, synced key instead.
 *
 * So this key is built the way the human key was — derived from the FULL local
 * `messages` array at payload-build time, carried whole or not at all, read as
 * authoritative by the cloud when present — and the desktop slice is gone.
 *
 * The predicate here is EXACTLY the row set the cloud's fallback SQL counts
 * (`agentLegacyMessageRowsSql` in `apps/api/app/insights/lib/activity-heatmap.ts`):
 * `role='assistant'`, plus a headless session's injected `role='human'` prompts
 * (the FEA-2641 promotion), minus a `/fork` child's replayed rows (ISS-8659).
 * Only the WINDOW changes, never the semantics — a session that carries this
 * key and one that falls back must agree on which rows are agent turns.
 *
 * It lives in `@repo/lib` for the reason the human module does: the desktop's
 * dependency-cruiser gate (`boot-no-design-system-runtime`) forbids the
 * boot-reachable sync payload module from reaching `src/main/database/`, where
 * the bucket derivation lives.
 */

export const AGENT_TURN_TIMESTAMPS_METADATA_KEY = "agentTurnTimestamps";

/**
 * Max entries the key may carry — the SAME bound as the human key, on purpose
 * and not by default.
 *
 * `metadata` is replicated into EVERY sync chunk, so two keys at cap cost
 * ~80 KB of the 262,144-byte request budget, ~30%. That is what the bound buys.
 * What it leaves capped: an agent unit is one `$.messages` row per content
 * BLOCK (text / tool_use / thinking), so a long session runs far past 1000 —
 * the golden corpus maximum is 1140 assistant rows, then 816, 670, 661, every
 * one of them a session that ALSO synced token events and so never reaches
 * this key. A token-event-less session past this bound emits NO key and the
 * cloud stays on its capped `$.messages` read — 100, as today — while the
 * desktop (which no longer slices) reports its full local count. The ruling
 * moves 100 → 1000, not 100 → unbounded; raising this is a separate ruling.
 */
export const MAX_METADATA_AGENT_TURN_TIMESTAMPS =
  MAX_METADATA_HUMAN_TURN_TIMESTAMPS;

/**
 * The legacy agent-turn units of one session's `$.messages`, in traversal
 * order — the rows the cloud's `agentLegacyMessageRowsSql` counts, spelled once
 * in TypeScript.
 *
 * `deriveSessionTurnBuckets` (`apps/desktop/src/main/database/turn-buckets.ts`)
 * emits one `turn_kind='agent'` bucket row per entry returned here on a
 * token-event-less session, so the key this feeds and the desktop chart cannot
 * disagree about WHICH rows count.
 *
 * Timestamps stay VERBATIM; validation is deliberately not applied here. A
 * NUMBER is skipped (not stringified), matching the cloud's
 * `jsonb_typeof(m -> 'timestamp') = 'string'` — only the human arm takes
 * numbers, and only because FEA-3597 froze its output byte-identical.
 */
export function collectLegacyAgentTurnUnits(
  messages: unknown,
  headless: boolean
): string[] {
  if (!Array.isArray(messages)) {
    return [];
  }
  const units: string[] = [];
  for (const el of messages) {
    if (typeof el !== "object" || el === null || Array.isArray(el)) {
      continue;
    }
    const { role, timestamp } = el as { role?: unknown; timestamp?: unknown };
    const isAgentRole = role === "assistant" || (role === "human" && headless);
    if (!isAgentRole) {
      continue;
    }
    // ISS-8659: a `/fork` child replays its parent's messages verbatim; those
    // turns happened in the parent, at the parent's timestamps.
    if (isForkReplayedMessage(el)) {
      continue;
    }
    if (typeof timestamp !== "string") {
      continue;
    }
    units.push(timestamp);
  }
  return units;
}

/**
 * The `metadata.agentTurnTimestamps` value for one session's FULL local
 * metadata, or `null` when the key must be omitted entirely.
 *
 * WHOLE OR ABSENT, for the reason `deriveHumanTurnTimestamps` states: the cloud
 * reader treats a present array as AUTHORITATIVE and stops consulting
 * `$.messages`, so a partial array would report FEWER agent turns than the
 * fallback it displaces. One unit outside the key grammar, or a count past
 * {@link MAX_METADATA_AGENT_TURN_TIMESTAMPS}, suppresses the key for the whole
 * session and the cloud stays on today's read — the same
 * {@link deriveTurnTimestamps} carry rule the human key runs.
 *
 * `[]` is a real value, not an absence: an interactive session whose messages
 * are all human has zero agent turns, the desktop derives no agent row for it,
 * and the cloud must report the same zero rather than fall back.
 *
 * This is pure over `metadata`. Whether the session synced token events — in
 * which case the cloud never reads this key — is the PRODUCER's decision
 * (`compactSessionMetadataForSync`), made from the session row, not the blob.
 */
export function deriveAgentTurnTimestamps(metadata: unknown): string[] | null {
  return deriveTurnTimestamps(
    metadata,
    collectLegacyAgentTurnUnits,
    MAX_METADATA_AGENT_TURN_TIMESTAMPS
  );
}
