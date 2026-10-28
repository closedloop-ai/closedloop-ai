import type { TransactionClient } from "@repo/database";
import { v7 as uuidv7 } from "uuid";
import {
  agentComponentProjection,
  type SearchProjectionInput,
} from "@/app/search/search-index-service";

/**
 * Reserved machine_name for the synthetic per-org "cloud" sentinel compute
 * target. Mirrors the literal used by the FEA-2923 backfill migration so the
 * forward path and the backfill converge on the same sentinel row (the
 * `@@unique([userId, machineName])` constraint makes it single-flight per user,
 * and the guard below keeps it single-flight per org).
 */
const CLOUD_SENTINEL_MACHINE_NAME = "__cloud_sentinel__";

/**
 * Ensure the org's cloud sentinel compute target exists (creating it on first
 * use, owned by the org's earliest active user — the same owner the backfill
 * migration picks) and return its id. Runs inside the caller's transaction.
 */
async function ensureCloudSentinelTarget(
  tx: TransactionClient,
  organizationId: string
): Promise<string | null> {
  const existing = await tx.computeTarget.findFirst({
    where: { organizationId, isCloudSentinel: true },
    select: { id: true },
  });
  if (existing) {
    return existing.id;
  }

  // Owner: the org's earliest-created active user (deterministic id tie-break),
  // matching migration 20260712000000. user_id is a NOT NULL FK; the sentinel
  // is org-owned in spirit but must reference a concrete user.
  const owner = await tx.user.findFirst({
    where: { organizationId, active: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (!owner) {
    // Defensive — every org has active users in practice. Without one we can't
    // satisfy the sentinel's NOT NULL user FK; skip materialization rather than
    // fail the whole write. The catalog item still lands; a later backfill
    // (once the org has a user) restores visibility.
    return null;
  }

  const created = await tx.computeTarget.create({
    data: {
      organizationId,
      userId: owner.id,
      machineName: CLOUD_SENTINEL_MACHINE_NAME,
      platform: "cloud",
      isCloudSentinel: true,
      selectedHarness: "claude",
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * Upsert the `agent_components` inventory row for a natively-created org_custom
 * agent onto the org's cloud sentinel target, mirroring the FEA-2923 backfill
 * migration's mapping:
 *   component_kind        = 'subagent'
 *   external_component_id = 'cloud:agent:<catalogItemId>'
 *   harness               = 'claude'
 *   component_key         = agentSlug (falls back to name)
 *   scope                 = 'org'
 * Keyed on the (compute_target_id, component_kind, external_component_id)
 * unique index — the same key desktop sync and the backfill dedupe on — so this
 * is idempotent and can never collide with a real device's rows.
 */
export async function materializeCloudAgentComponent(
  tx: TransactionClient,
  params: {
    organizationId: string;
    catalogItemId: string;
    name: string;
    componentKey: string;
    description: string | null;
    sourceRepo: string;
    createdById: string;
  },
  // FEA-4011 Slice A: the upserted component's search projection is pushed here
  // and flushed by the top-level caller AFTER the transaction commits (fail-open,
  // post-commit — the index write must never roll back this catalog write).
  pendingSearchIndex?: SearchProjectionInput[]
): Promise<void> {
  const sentinelId = await ensureCloudSentinelTarget(tx, params.organizationId);
  if (!sentinelId) {
    return;
  }

  const externalComponentId = `cloud:agent:${params.catalogItemId}`;
  const sourceUrl = params.sourceRepo === "" ? null : params.sourceRepo;
  const now = new Date();

  const upserted = await tx.agentComponent.upsert({
    where: {
      computeTargetId_componentKind_externalComponentId: {
        computeTargetId: sentinelId,
        componentKind: "subagent",
        externalComponentId,
      },
    },
    create: {
      organizationId: params.organizationId,
      computeTargetId: sentinelId,
      componentKind: "subagent",
      externalComponentId,
      harness: "claude",
      name: params.name,
      componentKey: params.componentKey || params.name,
      version: "1.0.0",
      description: params.description,
      sourceUrl,
      scope: "org",
      metadata: {
        cloudAuthored: true,
        catalogItemId: params.catalogItemId,
        legacyAgentId: null,
        source: "org_custom",
        createdById: params.createdById,
      },
      firstSeenAt: now,
      lastSeenAt: now,
    },
    update: {
      name: params.name,
      componentKey: params.componentKey || params.name,
      description: params.description,
      sourceUrl,
      lastSeenAt: now,
    },
  });

  pendingSearchIndex?.push(
    agentComponentProjection({
      id: upserted.id,
      organizationId: upserted.organizationId,
      componentKind: upserted.componentKind,
      name: upserted.name,
      componentKey: upserted.componentKey,
      externalComponentId: upserted.externalComponentId,
      description: upserted.description,
      updatedAt: upserted.updatedAt,
      // FEA-4335: route the search hit to the content-hash detail URI when the
      // row carries a hash (null for this cloud-authored row ⇒ name-level slug).
      contentHash: upserted.contentHash,
    })
  );
}

/**
 * Batch variant of {@link materializeCloudAgentComponent} for pack import:
 * materialize the `agent_components` rows for a set of freshly-created,
 * agent-kind pack components in a single `createMany` instead of one upsert per
 * agent. The org's cloud-sentinel target is resolved ONCE (shared by every
 * agent in the import) rather than re-read per component. A plain insert is
 * safe here (no upsert needed) because each row carries a brand-new catalogItem
 * id, so its `cloud:agent:<id>` external component id is guaranteed unique and
 * cannot collide with an existing row.
 */
export async function materializeCloudAgentComponentsBatch(
  tx: TransactionClient,
  params: {
    organizationId: string;
    createdById: string;
    components: ReadonlyArray<{
      catalogItemId: string;
      name: string;
      description: string | null;
    }>;
  },
  // FEA-4011 Slice A: each materialized component's search projection is pushed
  // here and flushed by the top-level caller AFTER the transaction commits.
  pendingSearchIndex?: SearchProjectionInput[]
): Promise<void> {
  if (params.components.length === 0) {
    return;
  }
  const sentinelId = await ensureCloudSentinelTarget(tx, params.organizationId);
  if (!sentinelId) {
    return;
  }
  const now = new Date();
  // Pre-derive each row's UUIDv7 id (matching schema.prisma's @default(uuid(7)))
  // so the search projection can carry the component id without a per-row
  // read-back after the batched createMany.
  const rows = params.components.map((component) => ({
    id: uuidv7(),
    organizationId: params.organizationId,
    computeTargetId: sentinelId,
    componentKind: "subagent",
    externalComponentId: `cloud:agent:${component.catalogItemId}`,
    harness: "claude",
    name: component.name,
    componentKey: component.name,
    version: "1.0.0",
    description: component.description,
    sourceUrl: null,
    scope: "org",
    metadata: {
      cloudAuthored: true,
      catalogItemId: component.catalogItemId,
      legacyAgentId: null,
      source: "org_custom",
      createdById: params.createdById,
    },
    firstSeenAt: now,
    lastSeenAt: now,
  }));
  await tx.agentComponent.createMany({ data: rows });

  if (pendingSearchIndex) {
    for (const row of rows) {
      pendingSearchIndex.push(
        agentComponentProjection({
          id: row.id,
          organizationId: row.organizationId,
          componentKind: row.componentKind,
          name: row.name,
          componentKey: row.componentKey,
          externalComponentId: row.externalComponentId,
          description: row.description,
          updatedAt: now,
        })
      );
    }
  }
}
