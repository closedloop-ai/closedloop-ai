/**
 * @file component-invocation-relink.ts
 * @description Re-resolve each stored invocation row's component/version links
 * and its attribution status from the current `agent_components` inventory.
 *
 * Extracted whole from component-invocations.ts (ISS-8180), a grandfathered
 * over-size file, on the ISS-7449 precedent: the write this owns had to change
 * and that file must not grow. Its three callers there import it back
 * one-directionally.
 */
import { AgentComponentInvocationAttributionStatus } from "@repo/api/src/types/agent-component-invocation";
import type { Prisma } from "./generated/client.js";

export async function relinkInvocationRows(
  tx: Prisma.TransactionClient,
  sessionIds: string[]
): Promise<void> {
  if (sessionIds.length === 0) {
    return;
  }
  const placeholders = sessionIds.map((_, index) => `$${index + 1}`).join(", ");
  const ambiguousParam = `$${sessionIds.length + 1}`;
  const matchedParam = `$${sessionIds.length + 2}`;
  const unmatchedParam = `$${sessionIds.length + 3}`;
  const unresolvedParam = `$${sessionIds.length + 4}`;
  // ISS-8180: joined via `UPDATE … FROM`, not correlated subqueries. The previous
  // form probed `component_matches` five times per row (`match_count` four of
  // them), which cost 23s on a 20k-invocation session. The join is row-scope
  // equivalent because the CTE is derived from THIS table under the SAME
  // `session_id` filter and grouped by `invocation.id`, so every row the old
  // `WHERE session_id IN (…)` reached has exactly one match row. Keep those two
  // filters in step: if the CTE's WHERE ever narrows past the UPDATE's, this
  // silently stops updating the difference instead of failing.
  await tx.$executeRawUnsafe(
    `WITH component_matches AS (
       SELECT invocation.id AS invocation_id,
              COUNT(component.id) AS match_count,
              MIN(component.id) AS matched_component_id
         FROM agent_component_invocations invocation
         LEFT JOIN agent_components component
           ON component.component_kind = invocation.component_kind
          AND component.component_key = invocation.component_key
        WHERE invocation.session_id IN (${placeholders})
        GROUP BY invocation.id
     )
     UPDATE agent_component_invocations
        SET local_component_id = CASE
              WHEN cm.match_count = 1 THEN cm.matched_component_id
              ELSE NULL
            END,
            local_component_version_id = CASE
              WHEN agent_component_invocations.definition_hash IS NULL OR
                   cm.match_count <> 1
                THEN NULL
              ELSE (
                SELECT av.id FROM agent_component_versions av
                 WHERE av.component_kind = agent_component_invocations.component_kind
                   AND av.component_key = agent_component_invocations.component_key
                   AND av.content_hash = agent_component_invocations.definition_hash
                 ORDER BY av.id LIMIT 1
              )
            END,
            attribution_status = CASE
              WHEN cm.match_count > 1 THEN ${ambiguousParam}
              WHEN agent_component_invocations.definition_hash IS NOT NULL AND
                   cm.match_count = 1
                THEN ${matchedParam}
              WHEN agent_component_invocations.definition_hash IS NOT NULL
                THEN ${unmatchedParam}
              ELSE ${unresolvedParam}
            END
       FROM component_matches cm
      WHERE cm.invocation_id = agent_component_invocations.id
        AND agent_component_invocations.session_id IN (${placeholders})`,
    ...sessionIds,
    AgentComponentInvocationAttributionStatus.Ambiguous,
    AgentComponentInvocationAttributionStatus.Matched,
    AgentComponentInvocationAttributionStatus.Unmatched,
    AgentComponentInvocationAttributionStatus.Unresolved
  );
}
