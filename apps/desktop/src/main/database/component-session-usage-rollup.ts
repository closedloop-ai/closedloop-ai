/**
 * @file component-session-usage-rollup.ts
 * @description The `agent_component_session_usage` rollup — the legacy per
 * session/component aggregate rebuilt from the durable invocation rows.
 *
 * Extracted whole from component-invocations.ts (ISS-7449), a grandfathered
 * over-size file, because the rollup's `invoked_at` bounds needed the two-mode
 * canonical fold and the write must not grow that file.
 */

import type { Prisma } from "./generated/client.js";
import {
  canonicalizeHealableTimestampSql,
  storedUtcDaySql,
} from "./session-timestamp-form.js";

const CANONICAL_INVOKED_AT_SQL =
  canonicalizeHealableTimestampSql("i.invoked_at");

/**
 * Rebuild the legacy aggregate from durable invocations, preserving its
 * pre-FEA-3294 per-event branch fallback without weakening exact invocation
 * attribution stored on the invocation rows themselves.
 */
export async function rebuildAgentComponentSessionUsageFromInvocations(
  tx: Prisma.TransactionClient,
  sessionIds: string[]
): Promise<void> {
  if (sessionIds.length === 0) {
    return;
  }
  const placeholders = sessionIds.map((_, index) => `$${index + 1}`).join(", ");
  await tx.$executeRawUnsafe(
    `DELETE FROM agent_component_session_usage WHERE session_id IN (${placeholders})`,
    ...sessionIds
  );
  /* ISS-8180: the CAST on provider_event_branch's json_extract is load-bearing for
     PERFORMANCE, not for the value it produces. A bare json_extract carries no type
     affinity, so SQLite will not accept it as an equality constraint: the automatic
     covering index it builds for the LEFT JOIN below then degrades to session_id
     alone, which is constant within one session's import, so every probe returns the
     entire CTE. That is O(invocations x events) - 33s for a 20k-tool-use session,
     against 168ms with the cast. The SELECT and the GROUP BY must carry it together;
     casting one and not the other silently restores the quadratic while still
     producing byte-identical rows, so no correctness test can catch it. */
  await tx.$executeRawUnsafe(
    `WITH timestamp_event_branch AS (
       SELECT
         session_id,
         created_at,
         tool_name,
         CASE
           WHEN COUNT(DISTINCT COALESCE(git_branch, '')) = 1
             THEN MAX(git_branch)
           ELSE NULL
         END AS git_branch
       FROM events
       WHERE session_id IN (${placeholders})
       GROUP BY session_id, created_at, tool_name
     ),
     provider_event_branch AS (
       SELECT
         session_id,
         CAST(json_extract(data, '$.providerToolUseId') AS TEXT) AS provider_tool_use_id,
         CASE
           WHEN COUNT(DISTINCT COALESCE(git_branch, '')) = 1
             THEN MAX(git_branch)
           ELSE NULL
         END AS git_branch
       FROM events
       WHERE session_id IN (${placeholders})
         AND json_type(data, '$.providerToolUseId') = 'text'
       GROUP BY session_id, CAST(json_extract(data, '$.providerToolUseId') AS TEXT)
     )
     INSERT INTO agent_component_session_usage
       (session_id, component_kind, component_key, git_branch,
        agent_component_id, harness, invocations, error_count,
        component_version_hash, first_invoked_at, last_invoked_at, started_day)
     SELECT
       i.session_id,
       i.component_kind,
       i.component_key,
       COALESCE(
         i.git_branch,
         anchor_event.git_branch,
         provider_event_branch.git_branch,
         timestamp_event_branch.git_branch,
         ''
       ),
       MAX(i.local_component_id),
       COALESCE(NULLIF(s.harness, ''), 'claude'),
       COUNT(*),
       SUM(CASE
             -- FEA-4093: a Hook firing carries its own success fact (it anchors
             -- to a Timestamp, not an error-bearing event/agent), and a tool
             -- row persists its result's, so count succeeded=0 as an error.
             WHEN i.succeeded = 0 THEN 1
             WHEN i.anchor_kind = 'event' AND EXISTS (
               SELECT 1 FROM events e
                WHERE e.id = i.anchor_value
                  AND (lower(e.event_type) LIKE '%error%'
                       OR lower(e.event_type) LIKE '%fail%'
                       OR json_extract(e.data, '$.isError') = 1)
             ) THEN 1
             WHEN i.anchor_kind = 'agent' AND EXISTS (
               SELECT 1 FROM agents a
                WHERE a.id = i.anchor_value
                  AND (lower(a.status) LIKE '%error%'
                       OR lower(a.status) LIKE '%fail%')
             ) THEN 1
             ELSE 0
           END),
       CASE
         WHEN COUNT(i.definition_hash) = COUNT(*)
          AND COUNT(DISTINCT i.definition_hash) = 1
           THEN MAX(i.definition_hash)
         ELSE NULL
       END,
       ${invokedAtBoundSql("MIN")},
       ${invokedAtBoundSql("MAX")},
       ${storedUtcDaySql("s.started_at")}
     FROM agent_component_invocations i
     JOIN sessions s ON s.id = i.session_id
     LEFT JOIN events anchor_event
       ON i.anchor_kind = 'event'
      AND anchor_event.id = i.anchor_value
      AND anchor_event.session_id = i.session_id
     LEFT JOIN provider_event_branch
       ON i.anchor_kind = 'event'
      AND provider_event_branch.session_id = i.session_id
      AND provider_event_branch.provider_tool_use_id = i.provider_tool_use_id
     LEFT JOIN timestamp_event_branch
       ON i.anchor_kind = 'timestamp'
      AND timestamp_event_branch.session_id = i.session_id
      AND timestamp_event_branch.created_at = i.invoked_at
      AND timestamp_event_branch.tool_name = CASE
        WHEN i.component_kind = 'skill' THEN 'Skill'
        ELSE i.raw_name
      END
     WHERE i.session_id IN (${placeholders})
     GROUP BY i.session_id, i.component_kind, i.component_key,
              COALESCE(
                i.git_branch,
                anchor_event.git_branch,
                provider_event_branch.git_branch,
                timestamp_event_branch.git_branch,
                ''
              ),
              s.harness, s.started_at`,
    ...sessionIds
  );
}

/**
 * ISS-7449: the `first_invoked_at` / `last_invoked_at` bound for one usage
 * group, ranked by INSTANT rather than by bytes.
 *
 * `invoked_at` is TEXT, so a bare `MIN`/`MAX` is a byte compare, and byte order
 * is time order only within one fixed-width form: `…:00Z` sorts ABOVE
 * `…:00.500Z` (`Z` 0x5A after `.` 0x2E) while being the EARLIER instant. The
 * winner is PERSISTED and synced, so folding the readers instead would mask a
 * bad row rather than stop it being written.
 *
 * All-or-nothing, never a per-value `COALESCE`: canonicalization LOWERS a value
 * whenever it applies a positive offset (ISS-5497), so one canonical operand
 * beside one raw operand lets an un-canonicalizable sibling out-sort the true
 * winner. `COUNT` skips NULLs, so the guard compares how many rows canonicalize
 * against how many hold a value AT ALL — `COUNT(*)` would drop a group holding
 * a NULL `invoked_at` to legacy mode.
 *
 * Canonical mode emits the fixed-width canonical form, NOT the winning row's
 * own spelling: `usageWindowClause` compares this column per-row against a
 * canonical ISO bound, so a raw `…T09:00:00-05:30` would drop a 14:30Z winner
 * out of a window its instant is inside. The cross-row `MAX` readers are not
 * folded yet and stay mixed-mode; ISS-7449 hands those sites back.
 */
function invokedAtBoundSql(aggregate: "MIN" | "MAX"): string {
  return `CASE
         WHEN COUNT(${CANONICAL_INVOKED_AT_SQL}) = COUNT(i.invoked_at)
           THEN ${aggregate}(${CANONICAL_INVOKED_AT_SQL})
         ELSE ${aggregate}(i.invoked_at)
       END`;
}
