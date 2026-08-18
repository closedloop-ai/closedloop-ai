import { randomUUID } from "node:crypto";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import type {
  SyncedAgentSession,
  SyncedComponentUsage,
} from "@repo/api/src/types/agent-session";
import { Prisma } from "@repo/database";
import { admitSyncedCommandUsage } from "@/lib/command-key-admission";
import { earliestTimestamp, latestTimestamp } from "@/lib/iso-timestamp-bounds";
import {
  isSkillShadowedPhantom,
  loadSkillShadowInventory,
  skillShadowBareName,
} from "@/lib/skill-shadow";
import { toDate } from "./coercion";
import type { AgentSessionUpsertTx } from "./records";

/**
 * Build a lookup key for an AgentComponent row's unique constraint
 * (componentKind, externalComponentId). Used to map incoming usage rows
 * onto existing inventory rows within a single compute target.
 */
function buildComponentLookupKey(
  componentKind: string,
  externalComponentId: string
): string {
  return `${componentKind}\x00${externalComponentId}`;
}

/**
 * Batch-fetch existing AgentComponent rows for the given compute target and
 * the set of (componentKind, externalComponentId) pairs referenced by the
 * session's usage entries. Returns a map from lookup key → agentComponentId
 * so the caller can resolve the nullable FK without N+1 queries.
 *
 * Only entries with a non-null externalComponentId are fetched; built-in
 * tools (e.g. Read/Bash) have no inventory row and always resolve to null.
 */
async function resolveAgentComponentIdMap(
  tx: AgentSessionUpsertTx,
  computeTargetId: string,
  usages: readonly SyncedComponentUsage[]
): Promise<Map<string, string>> {
  const pairs: Array<{ kind: string; externalId: string }> = [];
  for (const usage of usages) {
    const externalId = usage.externalComponentId?.trim();
    if (externalId) {
      pairs.push({ kind: usage.componentKind, externalId });
    }
  }
  if (pairs.length === 0) {
    return new Map();
  }

  const rows = await tx.agentComponent.findMany({
    where: {
      computeTargetId,
      OR: pairs.map(({ kind, externalId }) => ({
        componentKind: kind,
        externalComponentId: externalId,
      })),
    },
    select: {
      id: true,
      componentKind: true,
      externalComponentId: true,
    },
  });

  const result = new Map<string, string>();
  for (const row of rows) {
    result.set(
      buildComponentLookupKey(row.componentKind, row.externalComponentId),
      row.id
    );
  }
  return result;
}

/**
 * T-7.6 / AC-011: upsert AgentComponentSessionUsage rows for all entries in
 * `session.components[]`. Idempotent — keyed by (agentSessionId, componentKind,
 * componentKey). Omission (older desktop builds that do not send the field)
 * is a no-op: previously persisted rows are left untouched.
 *
 * The nullable agentComponentId FK is resolved via a batched lookup on
 * (computeTargetId, componentKind, externalComponentId) — no server-side
 * re-parsing of events; the desktop sends the pre-materialized usage rows.
 */
export async function persistSessionComponentUsage(
  tx: AgentSessionUpsertTx,
  computeTargetId: string,
  agentSessionId: string,
  session: SyncedAgentSession
): Promise<void> {
  const reported = session.components;
  if (!reported || reported.length === 0) {
    return;
  }

  // ISS-4795/ISS-4796: normalize legacy Desktop command spellings before
  // folding skill-shadowed command rows and persisting the authoritative set.
  const rawUsages = admitSyncedCommandUsage(reported);
  if (rawUsages.length === 0) {
    return;
  }

  // ISS-4778: version-skew guard. An older Desktop still reports a phantom
  // `command` rollup for a slash-invoked SKILL; persisting it would recreate the
  // usage rows the one-time backfill migration just collapsed. Folded BEFORE the
  // branch-bucket prune below so the phantom's own group never participates in
  // the keep-set computation.
  const { shadowedCommandKeys, usages: foldedUsages } =
    await foldSkillShadowedCommandUsage(tx, computeTargetId, rawUsages);
  const usages = dedupeComponentUsages(foldedUsages);
  if (shadowedCommandKeys.length > 0) {
    // Mirrors the backfill migration's step 2b: the phantom's own rollup rows
    // are removed rather than left behind, because the counts they held are now
    // summed into the skill group the payload is authoritative for. Without this
    // a row persisted by an earlier skewed sync would keep double-counting.
    await tx.agentComponentSessionUsage.deleteMany({
      where: {
        agentSessionId,
        componentKey: { in: shadowedCommandKeys },
        componentKind: AgentComponentKind.Command,
      },
    });
  }

  const componentIdMap = await resolveAgentComponentIdMap(
    tx,
    computeTargetId,
    usages
  );

  // FEA-2990 double-count guard: the natural key now includes gitBranch, so a
  // resync that moves a (session, component) off the old '' bucket to real
  // branch buckets — e.g. an older desktop build synced `''`, a newer one now
  // sends `feat/a`+`feat/b` for the same (kind, key) — would otherwise leave the
  // stale `''` row behind. Detail + token-trend sum ALL rows per (kind, key), so
  // that orphan double-counts invocations. The desktop rematerializes and sends
  // the COMPLETE set of branch buckets for every (kind, key) it reports, so the
  // payload is authoritative: for each present (kind, key) group, drop any
  // existing branch bucket the payload no longer includes before upserting.
  // True branchless rows still present in the payload survive (their `''` bucket
  // is in the keep-set). Groups absent from the payload are untouched — an
  // omitted section never clears previously synced cloud rows.
  const branchBucketsByComponent = new Map<
    string,
    { componentKind: string; componentKey: string; branches: Set<string> }
  >();
  for (const usage of usages) {
    const groupKey = `${usage.componentKind}\u0000${usage.componentKey}`;
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
  await tx.agentComponentSessionUsage.deleteMany({
    where: {
      agentSessionId,
      OR: [...branchBucketsByComponent.values()].map(
        ({ componentKind, componentKey, branches }) => ({
          componentKind,
          componentKey,
          gitBranch: { notIn: [...branches] },
        })
      ),
    },
  });

  const rows = usages.map((usage) => {
    const externalId = usage.externalComponentId?.trim() ?? null;
    const agentComponentId = externalId
      ? (componentIdMap.get(
          buildComponentLookupKey(usage.componentKind, externalId)
        ) ?? null)
      : null;

    // FEA-2990: '' is the "no per-event branch" natural-key sentinel — used for
    // Codex/legacy/non-tool buckets and for older desktop builds that omit the
    // field. Those rows keep the single session-level bucket; the cloud detail
    // read then falls back to session-level SessionBranch attribution for them.
    const gitBranch = usage.gitBranch?.trim() ?? "";

    const data = {
      agentComponentId,
      harness: usage.harness ?? null,
      invocationCount: usage.invocations,
      errorCount: usage.errorCount,
      // FEA-2923: hash-at-invocation attribution (null when uncollected).
      componentVersionHash: usage.componentVersionHash ?? null,
      firstInvokedAt: toDate(usage.firstInvokedAt),
      lastInvokedAt: toDate(usage.lastInvokedAt),
    };

    return {
      agentSessionId,
      id: randomUUID(),
      componentKind: usage.componentKind,
      componentKey: usage.componentKey,
      gitBranch,
      ...data,
    };
  });

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
      first_invoked_at,
      last_invoked_at,
      created_at,
      updated_at
    )
    VALUES ${Prisma.join(
      rows.map(
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
      first_invoked_at = EXCLUDED.first_invoked_at,
      last_invoked_at = EXCLUDED.last_invoked_at,
      updated_at = NOW()
  `;
}

function dedupeComponentUsages(
  usages: readonly SyncedComponentUsage[]
): SyncedComponentUsage[] {
  const byNaturalKey = new Map<string, SyncedComponentUsage>();
  for (const usage of usages) {
    byNaturalKey.set(usageBucketKey(usage), usage);
  }
  return [...byNaturalKey.values()];
}

/** The natural key a usage row upserts on, minus the session. */
function usageBucketKey(usage: SyncedComponentUsage): string {
  return `${usage.componentKind}\u0000${usage.componentKey}\u0000${usage.gitBranch?.trim() ?? ""}`;
}

/** Sum a phantom rollup into the skill rollup that survives it. */
function mergeUsage(
  survivor: SyncedComponentUsage,
  phantom: SyncedComponentUsage
): SyncedComponentUsage {
  return {
    ...survivor,
    errorCount: survivor.errorCount + phantom.errorCount,
    firstInvokedAt: earliestTimestamp(
      survivor.firstInvokedAt,
      phantom.firstInvokedAt
    ),
    invocations: survivor.invocations + phantom.invocations,
    lastInvokedAt: latestTimestamp(
      survivor.lastInvokedAt,
      phantom.lastInvokedAt
    ),
  };
}

/**
 * ISS-4778 (Part 2 of ISS-4775) — fold the phantom `command` rollups a
 * version-skewed Desktop still reports for slash-invoked skills into the real
 * skill rollup, matching the one-time backfill migration exactly: sum the counts
 * into a colliding skill bucket (step 2a), or re-point the bucket onto the skill
 * identity when nothing collides (step 2c).
 *
 * Deliberately conservative. A usage row carries no `resolvedState`/`content`, so
 * the stored inventory is the evidence: a slash-keyed command folds only when a
 * RESOLVED skill with the bare name exists on this compute target AND no
 * RESOLVED command with that slash key does. A genuine `/deploy` — with or
 * without a `deploy` skill beside it — is always kept.
 *
 * Costs at most ONE extra indexed read, and only when the payload actually
 * carries a slash-keyed command rollup.
 */
async function foldSkillShadowedCommandUsage(
  tx: AgentSessionUpsertTx,
  computeTargetId: string,
  usages: readonly SyncedComponentUsage[]
): Promise<{
  usages: SyncedComponentUsage[];
  shadowedCommandKeys: string[];
}> {
  const bareNameByUsage = new Map<SyncedComponentUsage, string>();
  for (const usage of usages) {
    const bareName = skillShadowBareName(
      usage.componentKind,
      usage.componentKey
    );
    if (bareName) {
      bareNameByUsage.set(usage, bareName);
    }
  }
  if (bareNameByUsage.size === 0) {
    return { shadowedCommandKeys: [], usages: [...usages] };
  }

  const inventory = await loadSkillShadowInventory(tx, computeTargetId, [
    ...new Set(bareNameByUsage.values()),
  ]);
  const { resolvedSkills } = inventory;

  const kept: SyncedComponentUsage[] = [];
  const phantoms: Array<{ bareName: string; usage: SyncedComponentUsage }> = [];
  const shadowedCommandKeys = new Set<string>();
  for (const usage of usages) {
    const bareName = bareNameByUsage.get(usage);
    // ISS-4923 (wongk review): the shared predicate, so this lane and the
    // invocation normalization can never disagree about what a phantom is.
    const isPhantom = isSkillShadowedPhantom(
      inventory,
      bareName ?? null,
      usage.componentKey
    );
    if (bareName && isPhantom) {
      phantoms.push({ bareName, usage });
      shadowedCommandKeys.add(usage.componentKey);
    } else {
      kept.push(usage);
    }
  }
  if (phantoms.length === 0) {
    return { shadowedCommandKeys: [], usages: kept };
  }

  const byBucket = new Map<string, number>();
  for (const [index, usage] of kept.entries()) {
    byBucket.set(usageBucketKey(usage), index);
  }
  for (const { bareName, usage } of phantoms) {
    const skill = resolvedSkills.get(bareName);
    const rewritten: SyncedComponentUsage = {
      ...usage,
      componentKind: AgentComponentKind.Skill,
      componentKey: bareName,
      externalComponentId: skill?.externalComponentId ?? null,
    };
    const bucketKey = usageBucketKey(rewritten);
    const survivorIndex = byBucket.get(bucketKey);
    if (survivorIndex === undefined) {
      byBucket.set(bucketKey, kept.length);
      kept.push(rewritten);
    } else {
      kept[survivorIndex] = mergeUsage(kept[survivorIndex], rewritten);
    }
  }
  return { shadowedCommandKeys: [...shadowedCommandKeys], usages: kept };
}
