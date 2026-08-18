/**
 * @file shared-agent-sessions-load-shapes.ts
 * @description The `loadSyncedSessions` option shapes the shared-sessions reads
 * hydrate with.
 *
 * Lifted out of `shared-agent-sessions-api.ts` (a shrink-only grandfathered
 * module) by ISS-6119: which columns a read is allowed to skip is a contract
 * between the read and its FOLD, and every knob on it needs the argument for why
 * the fold cannot observe the omission. That argument does not belong inline in
 * a 1,500-line composition file.
 */
import type { SyncedSessionLoadOptions } from "../agent-sync/agent-session-sync-source.js";

/**
 * The list / analytics hydration shape.
 *
 * NOT the FEA-1834 lightweight usage load — that one is `loadSqliteUsageSessions`,
 * which reads only `sessions` + `token_usage` through its own `selectSessionRows`
 * call and takes no options at all.
 *
 * - FEA-2038 `omitEventData`: these folds are `mapListItem` /`matchesQuery` /
 *   `buildUsageSummary` / `buildAnalytics`, none of which read `event.data`, and
 *   the full-corpus fallback would otherwise retain every event payload at once.
 * - ISS-6050 `omitTokenEventCostColumns`: `cost_summary` / `source_identity` are
 *   read only by the cloud payload builder, which has its own load.
 * - ISS-6119 `omitPreviewStrippedMetadata`: no module reachable from a hydrated
 *   `SyncedAgentSession.metadata` on this path reads `OMITTED_METADATA_KEYS`.
 *   These folds reach `metadata` only through `buildTraceTimelineRows`
 *   (`messages`, `slashCommands`) and `buildSessionTraceSyncFields` (`diffStats`,
 *   `userMessages`, `assistantMessages`, `entrypoint`). On the real corpus the
 *   dropped key is 52.5% of every metadata blob the full-corpus fallback would
 *   otherwise parse.
 *
 * The DETAIL and branch-trace reads hydrate separately and take none of these.
 */
export const LIST_LOAD: SyncedSessionLoadOptions = {
  omitEventData: true,
  omitTokenEventCostColumns: true,
  omitPreviewStrippedMetadata: true,
};
