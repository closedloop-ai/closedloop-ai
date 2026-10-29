import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import type { SyncedComponentUsage } from "@repo/api/src/types/agent-session";
import { Prisma } from "@repo/database";
import { v7 as uuidv7 } from "uuid";
import { indexKeyLookupCandidates } from "@/lib/index-key-lookup";
import { toDate } from "./coercion";
import type { AgentSessionUpsertTx } from "./records";
import { bindParameterChunkSize } from "./write-chunking";

/**
 * ISS-8185: the statements `persistSessionComponentUsage` emits, split out of
 * `component-usage.ts` so the orchestration (admission, skill-shadow folding,
 * dedupe) stays separate from the writes — and so the bind-parameter boundary
 * for each statement lives in one place. Each helper runs
 * inside the caller's session-upsert transaction, so a chunked write is still
 * all-or-nothing.
 */

/**
 * ISS-8185: bind parameters the `agent_component_session_usage` INSERT emits
 * per row — one per interpolated column in its VALUES tuple. `NOW()` is literal
 * SQL and costs nothing. Hand-maintained against that tuple: widen it in the
 * same change that adds a column, or the derived chunk size stops bounding the
 * statement.
 */
const USAGE_INSERT_BIND_PARAMETERS_PER_ROW = 13;

/**
 * One `componentKey` per element of an `IN (...)` list.
 *
 * DELIBERATELY CONSERVATIVE, and measured so (ISS-8185, Prisma 7.8 /
 * `@prisma/adapter-pg` / PostgreSQL 16): this Prisma compiles a scalar `in` to a
 * SINGLE array parameter, so the delete below actually binds three parameters no
 * matter how long the key list is — a 200,000-element `in` was accepted. The
 * per-element model is kept anyway because it is the pessimistic one: it costs a
 * second statement on a payload no real session reaches, and it is what keeps
 * this lane bounded if a future Prisma goes back to expanding the list. Do not
 * "correct" it to 0 — that would remove the bound, not tighten it.
 */
const KEY_LIST_BIND_PARAMETERS_PER_KEY = 1;

/**
 * ISS-8185: binds the shadow delete carries OUTSIDE its `componentKey` list —
 * `agentSessionId` and the constant `componentKind`. Reserved rather than
 * ignored: a slice sized against the whole ceiling puts the statement two
 * parameters over it.
 */
const SHADOW_DELETE_FIXED_BIND_PARAMETERS = 2;

/** The usage INSERT binds nothing outside its `VALUES` tuples. */
const USAGE_INSERT_FIXED_BIND_PARAMETERS = 0;

/**
 * Build a lookup key for an AgentComponent row's unique constraint
 * (componentKind, externalComponentId). Used to map incoming usage rows
 * onto existing inventory rows within a single compute target.
 */
export function buildComponentLookupKey(
  componentKind: string,
  externalComponentId: string
): string {
  return `${componentKind}\x00${externalComponentId}`;
}

export type ComponentInventoryLookupPair = {
  componentKind: string;
  externalComponentId: string;
};

type ComponentInventoryLookupRow = ComponentInventoryLookupPair & {
  id: string;
};

/**
 * Resolve usage rows onto the component inventory with a payload-independent
 * statement shape. The arrays are the bind values, not each element inside
 * them, so distinct component cardinality cannot widen the SQL statement.
 */
export async function loadComponentInventoryRows(
  tx: AgentSessionUpsertTx,
  computeTargetId: string,
  pairs: readonly ComponentInventoryLookupPair[]
): Promise<ComponentInventoryLookupRow[]> {
  if (pairs.length === 0) {
    return [];
  }

  // ISS-8200: the caller's pairs are already PROJECTED (the usage lane projects
  // every index key before anything touches a column), but an `agent_components`
  // row written before ISS-8069 bounded these columns still holds the RAW
  // 513-2704-byte value — long enough to project, short enough for the btree to
  // have accepted it. Joining on the projected pair alone misses that row, and
  // the usage row then persists with `agent_component_id` silently NULL: the
  // measurement lands, unlinked from the inventory it describes, and nothing
  // ever re-links it. Unioning the raw candidate into the same statement keeps
  // the join payload-independent — this is a SET read, so it unions the
  // candidates rather than probing them in order the way
  // `lib/index-key-lookup.ts` does for a point read, and the two share one
  // definition of which keys could hold the identity.
  const componentKinds: string[] = [];
  const externalComponentIds: string[] = [];
  for (const pair of pairs) {
    for (const kind of indexKeyLookupCandidates(pair.componentKind)) {
      for (const externalId of indexKeyLookupCandidates(
        pair.externalComponentId
      )) {
        componentKinds.push(kind);
        externalComponentIds.push(externalId);
      }
    }
  }

  return await tx.$queryRaw<ComponentInventoryLookupRow[]>`
    SELECT
      c.id,
      c.component_kind AS "componentKind",
      c.external_component_id AS "externalComponentId"
    FROM agent_components AS c
    JOIN unnest(${componentKinds}::text[], ${externalComponentIds}::text[])
      AS lookup(component_kind, external_component_id)
      ON lookup.component_kind = c.component_kind
      AND lookup.external_component_id = c.external_component_id
    WHERE c.compute_target_id = ${computeTargetId}::uuid
  `;
}

/** Map one admitted usage entry to the row the INSERT below binds. */
export function toComponentUsageInsertRow(
  agentSessionId: string,
  usage: SyncedComponentUsage,
  componentIdMap: ReadonlyMap<string, string>
) {
  const externalId = usage.externalComponentId?.trim() ?? null;
  const agentComponentId = externalId
    ? (componentIdMap.get(
        buildComponentLookupKey(usage.componentKind, externalId)
      ) ?? null)
    : null;

  return {
    agentSessionId,
    id: uuidv7(),
    componentKind: usage.componentKind,
    componentKey: usage.componentKey,
    // FEA-2990: '' is the "no per-event branch" natural-key sentinel — used for
    // Codex/legacy/non-tool buckets and for older desktop builds that omit the
    // field. Those rows keep the single session-level bucket; the cloud detail
    // read then falls back to session-level SessionBranch attribution for them.
    gitBranch: usage.gitBranch?.trim() ?? "",
    agentComponentId,
    harness: usage.harness ?? null,
    invocationCount: usage.invocations,
    errorCount: usage.errorCount,
    // FEA-2923: hash-at-invocation attribution (null when uncollected).
    componentVersionHash: usage.componentVersionHash ?? null,
    // ISS-7259: TRUE or NULL only. The wire omits the field for a row that is
    // not the attributed skill, so an absent value covers both an older
    // desktop and a current one reporting "not this row"; `?? false` would
    // turn the first into a claim we looked, which it cannot support.
    isFirstAttributedSkill: usage.isFirstAttributedSkill ?? null,
    firstInvokedAt: toDate(usage.firstInvokedAt),
    lastInvokedAt: toDate(usage.lastInvokedAt),
  };
}

type ComponentUsageInsertRow = ReturnType<typeof toComponentUsageInsertRow>;

/**
 * ISS-4778 step 2b: the phantom's own rollup rows are removed rather than left
 * behind, because the counts they held are now summed into the skill group the
 * payload is authoritative for. Without this a row persisted by an earlier
 * skewed sync would keep double-counting.
 *
 * ISS-8185: the key list is as long as the payload's slash-keyed command
 * rollups, so it is chunked like every other statement on this lane.
 */
export async function deleteShadowedCommandRows(
  tx: AgentSessionUpsertTx,
  agentSessionId: string,
  shadowedCommandKeys: readonly string[]
): Promise<void> {
  const chunkSize = bindParameterChunkSize(
    KEY_LIST_BIND_PARAMETERS_PER_KEY,
    SHADOW_DELETE_FIXED_BIND_PARAMETERS
  );
  for (let start = 0; start < shadowedCommandKeys.length; start += chunkSize) {
    await tx.agentComponentSessionUsage.deleteMany({
      where: {
        agentSessionId,
        componentKey: {
          in: [...shadowedCommandKeys.slice(start, start + chunkSize)],
        },
        componentKind: AgentComponentKind.Command,
      },
    });
  }
}

/** One branch-bucket group's natural key, minus the branch. */
export type ComponentUsageGroup = {
  componentKind: string;
  componentKey: string;
};

/**
 * FEA-2990: drop the branch buckets the authoritative payload no longer lists.
 *
 * ISS-8062: emitted as ONE statement whose parameter count does not depend on
 * the payload at all — six binds, always.
 *
 * CHUNKING COULD NOT BOUND THIS, which is why it is not sliced like its
 * neighbours. The per-group `notIn` predicate this replaced bound one parameter
 * per KEPT BRANCH, so a single component observed on many branches put its whole
 * branch set into one statement however few groups a slice carried, and that set
 * is not splittable: `notIn` is INTERSECTIVE, so running `notIn [a]` and
 * `notIn [b]` as two statements deletes b and then a — everything — instead of
 * neither. Packing groups by measured cost therefore still left the real bind
 * count unbounded for that shape (measured on this stack: Prisma refuses a bare
 * `notIn` of 32,764 branches, and accepts 32,763).
 *
 * So the payload travels as `text[]` values instead of as parameters: the group
 * set as two arrays, the keep-set as three. Row-for-row identical to the
 * per-group `notIn` — the buckets are keyed on (kind, key), so every group is
 * unique and "this row's (kind, key, branch) is absent from the keep-set" is
 * exactly "this row's branch is absent from THIS group's branch set".
 * `git_branch` is NOT NULL with a `''` default, so no row is skipped by
 * three-valued logic that the `notIn` would have kept.
 *
 * ISS-8253: `legacyGroups` carries the PRE-PROJECTION `(kind, key)` of any group
 * ISS-8125 re-keyed, and it joins the group set only — never the keep-set. Empty
 * for every payload whose keys fit the index budget, which is all of them in
 * practice, and then this is byte-for-byte the statement it was.
 */
export async function pruneStaleBranchBuckets(
  tx: AgentSessionUpsertTx,
  agentSessionId: string,
  usages: readonly SyncedComponentUsage[],
  legacyGroups: readonly ComponentUsageGroup[] = []
): Promise<void> {
  const branchBucketsByComponent = new Map<
    string,
    { componentKind: string; componentKey: string; branches: Set<string> }
  >();
  for (const usage of usages) {
    const groupKey = usageGroupKey(usage);
    const branch = usage.gitBranch?.trim() ?? "";
    const existing = branchBucketsByComponent.get(groupKey);
    if (existing) {
      existing.branches.add(branch);
    } else {
      branchBucketsByComponent.set(groupKey, {
        componentKind: usage.componentKind,
        componentKey: usage.componentKey,
        branches: new Set([branch]),
      });
    }
  }
  if (branchBucketsByComponent.size === 0) {
    return;
  }

  const groupKinds: string[] = [];
  const groupKeys: string[] = [];
  const keepKinds: string[] = [];
  const keepKeys: string[] = [];
  const keepBranches: string[] = [];
  for (const {
    componentKind,
    componentKey,
    branches,
  } of branchBucketsByComponent.values()) {
    groupKinds.push(componentKind);
    groupKeys.push(componentKey);
    for (const branch of branches) {
      keepKinds.push(componentKind);
      keepKeys.push(componentKey);
      keepBranches.push(branch);
    }
  }
  // ISS-8253: the RAW (kind, key) of every group this ticket's projection
  // re-keyed, added to the GROUP set and never to the keep-set — so a legacy row
  // stored under the pre-projection key is deleted here and re-inserted under
  // the projected one by the caller's `ON CONFLICT` upsert. Without it the
  // projected insert conflicts with nothing, the raw row survives, and detail +
  // token-trend — which sum ALL rows per (kind, key) — double-count that
  // component forever. Deliberate migrate-on-resync: the payload is
  // authoritative for every branch bucket of a group it reports, so nothing is
  // lost, and only a group the payload reports is ever touched.
  for (const group of legacyGroups) {
    groupKinds.push(group.componentKind);
    groupKeys.push(group.componentKey);
  }

  await tx.$executeRaw`
    DELETE FROM agent_component_session_usage AS u
    WHERE u.agent_session_id = ${agentSessionId}::uuid
      AND EXISTS (
        SELECT 1
        FROM unnest(${groupKinds}::text[], ${groupKeys}::text[])
          AS g(component_kind, component_key)
        WHERE g.component_kind = u.component_kind
          AND g.component_key = u.component_key
      )
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(
          ${keepKinds}::text[],
          ${keepKeys}::text[],
          ${keepBranches}::text[]
        ) AS k(component_kind, component_key, git_branch)
        WHERE k.component_kind = u.component_kind
          AND k.component_key = u.component_key
          AND k.git_branch = u.git_branch
      )
  `;
}

/**
 * ISS-8185: emit the authoritative usage set across as many statements as
 * PostgreSQL's bind-parameter ceiling allows, instead of one statement whose
 * width is the payload's. Every row still lands; `dedupeComponentUsages` has
 * already made the natural keys distinct, so no chunk can conflict with
 * another's rows and `ON CONFLICT DO UPDATE` behaves exactly as it did
 * unchunked. The whole loop runs inside the caller's session-upsert
 * transaction, so a chunk that fails rolls the session back rather than
 * leaving it half-persisted — same shape as `persistSessionTokenEvents`.
 */
export async function insertComponentUsageRows(
  tx: AgentSessionUpsertTx,
  rows: readonly ComponentUsageInsertRow[]
): Promise<void> {
  const chunkSize = bindParameterChunkSize(
    USAGE_INSERT_BIND_PARAMETERS_PER_ROW,
    USAGE_INSERT_FIXED_BIND_PARAMETERS
  );
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    await tx.$executeRaw`
    INSERT INTO agent_component_session_usage (
      id,
      agent_session_id,
      component_kind,
      component_key,
      git_branch,
      agent_component_id,
      harness,
      invocation_count,
      error_count,
      component_version_hash,
      is_first_attributed_skill,
      first_invoked_at,
      last_invoked_at,
      created_at,
      updated_at
    )
    VALUES ${Prisma.join(
      chunk.map(
        (row) => Prisma.sql`(
          ${row.id}::uuid,
          ${row.agentSessionId}::uuid,
          ${row.componentKind},
          ${row.componentKey},
          ${row.gitBranch},
          ${row.agentComponentId}::uuid,
          ${row.harness},
          ${row.invocationCount},
          ${row.errorCount},
          ${row.componentVersionHash},
          ${row.isFirstAttributedSkill},
          ${row.firstInvokedAt},
          ${row.lastInvokedAt},
          NOW(),
          NOW()
        )`
      )
    )}
    ON CONFLICT (agent_session_id, component_kind, component_key, git_branch)
    DO UPDATE SET
      agent_component_id = EXCLUDED.agent_component_id,
      harness = EXCLUDED.harness,
      invocation_count = EXCLUDED.invocation_count,
      error_count = EXCLUDED.error_count,
      component_version_hash = EXCLUDED.component_version_hash,
      -- ISS-7259: refreshed on conflict like every other column. Omitting it
      -- would freeze the flag at whatever the first sync of this bucket saw, so
      -- a session whose attributed skill changed on re-parse would keep the
      -- stale row flagged and never flag the right one.
      is_first_attributed_skill = EXCLUDED.is_first_attributed_skill,
      first_invoked_at = EXCLUDED.first_invoked_at,
      last_invoked_at = EXCLUDED.last_invoked_at,
      updated_at = NOW()
  `;
  }
}

/** The branch-bucket group a usage row belongs to: its natural key, minus the branch. */
function usageGroupKey(usage: SyncedComponentUsage): string {
  return `${usage.componentKind}\u0000${usage.componentKey}`;
}
