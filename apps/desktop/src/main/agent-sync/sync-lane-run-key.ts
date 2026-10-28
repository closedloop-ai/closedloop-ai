/**
 * @file sync-lane-run-key.ts
 * @description PLN-2028 D2 (ISS-10053): WHICH `sync_state` row a lane's durable
 * lane run lives on — one per (lane, compute target), which is not what the live
 * source key alone names.
 *
 * Its own module, on the AGENT-SYNC side of the boundary, because both a store
 * module and a lane need it and only one of those may import the other. The
 * store's row projection (`database/sync-lane-run-row.ts`) reads it, and so does
 * the session lane's own collaborator, which uses it as its identity — and
 * `main/database/**` is off the eager boot path (`boot-no-design-system-runtime`
 * in `scripts/dependency-cruiser.config.cjs`), so a lane reaching into the store
 * for it would drag the whole db graph onto boot.
 */

import {
  AGENT_SESSION_MONITORED_ACTIVITY_PAYLOAD_REVISION,
  AGENT_SESSION_SYNC_SOURCE_KIND,
  buildAgentSessionSyncSourceKey,
  splitAgentSessionSyncSourceKey,
} from "./agent-session-sync-source.js";

/**
 * The `sync_state` row a lane's durable lane run lives on.
 *
 * The session lane's key carries the negotiated monitored-activity revision, so
 * that key flips between `agent_sessions:<revision>:<target>` and
 * `agent_sessions:<target>` whenever a hello ack moves that capability (a
 * rollout or rollback). The in-memory run already compares only the target
 * (ISS-8610); a durable run keyed by the whole key would split across both rows
 * and resume a stale one. So a revision key maps to its target's short key.
 *
 * Every other key is its own lane-run key: the component lane's revision segment
 * is a build constant (so migration 0082's revision-bump caveat still holds
 * there), and an outbox partition key such as `agent_sessions:parked:<org>` is
 * not a lane identity at all.
 */
export function buildLaneRunSourceKey(sourceKey: string): string {
  const split = splitAgentSessionSyncSourceKey(sourceKey);
  return split?.lanePrefix === MONITORED_ACTIVITY_SESSION_LANE_PREFIX
    ? buildAgentSessionSyncSourceKey(split.computeTargetId)
    : sourceKey;
}

const MONITORED_ACTIVITY_SESSION_LANE_PREFIX = `${AGENT_SESSION_SYNC_SOURCE_KIND}:${AGENT_SESSION_MONITORED_ACTIVITY_PAYLOAD_REVISION}`;
