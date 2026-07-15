import type {
  SyncedAgentSession,
  SyncedComponentUsage,
} from "@repo/api/src/types/agent-session";
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
  const usages = session.components;
  if (!usages || usages.length === 0) {
    return;
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
  for (const {
    componentKind,
    componentKey,
    branches,
  } of branchBucketsByComponent.values()) {
    await tx.agentComponentSessionUsage.deleteMany({
      where: {
        agentSessionId,
        componentKind,
        componentKey,
        gitBranch: { notIn: Array.from(branches) },
      },
    });
  }

  for (const usage of usages) {
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
      firstInvokedAt: toDate(usage.firstInvokedAt),
      lastInvokedAt: toDate(usage.lastInvokedAt),
    };

    await tx.agentComponentSessionUsage.upsert({
      where: {
        agentSessionId_componentKind_componentKey_gitBranch: {
          agentSessionId,
          componentKind: usage.componentKind,
          componentKey: usage.componentKey,
          gitBranch,
        },
      },
      create: {
        agentSessionId,
        componentKind: usage.componentKind,
        componentKey: usage.componentKey,
        gitBranch,
        ...data,
      },
      update: data,
    });
  }
}
