import "server-only";

import {
  type CatalogItemDto,
  CatalogItemSource,
} from "@repo/api/src/types/distribution";
import { Result } from "@repo/api/src/types/result";
import {
  CatalogAssetTooLargeError,
  catalogAssetKey,
  getCatalogAssetBytes,
  getCatalogAssetDownloadUrl,
  getCatalogAssetUploadUrl,
  headCatalogAsset,
  resolveCatalogBucket,
} from "@repo/aws";
import {
  GitHubInstallationStatus,
  type Prisma,
  type TransactionClient,
  withDb,
} from "@repo/database";
import type {
  ContextPackAgent,
  ContextPackRepoConfig,
} from "@closedloop-ai/loops-api/context-pack";
import { log } from "@repo/observability/log";
import { BoundedCache } from "@/lib/bounded-cache";
import { getPrismaErrorCode } from "@/lib/db-utils";
import { deriveComponentUuid } from "./component-uuid";
import type { ParsedComponent } from "./pack-component-parse";
import { fetchRepoComponents } from "./pack-repo-import";
import { PackZipTooLargeError, parsePackZip } from "./pack-zip-import";
import { createCatalogItemBodySchema } from "./validators";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Slugify a string into a URL-safe identifier.
 * Matches the logic from apps/api/app/agents/service.ts so that roles
 * produce identical slugs after migration.
 */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Derive a context-pack slug from a CatalogItem's role or name.
 * `role` is the bootstrap dedup key and mirrors `Agent.role`; falling
 * back to `name` ensures items without a role still produce a slug.
 *
 * Used only as the base for `generateUniqueAgentSlug` at ingest and as a
 * last-resort fallback in `listAgentsForContextPack` for legacy rows whose
 * `agentSlug` was never persisted — the persisted slug is otherwise SSOT.
 */
function catalogItemSlug(role: string | null, name: string): string {
  return slugify(role ?? name);
}

/**
 * Compute an org-scoped-unique context-pack slug for a new agent CatalogItem,
 * disambiguating same-base collisions with -2/-3/… suffixes. Mirrors the
 * superseded `agentsService.generateUniqueSlug` so two agents that share a
 * `role` but differ by `sourceRepo` get distinct, stable harness file names
 * (`.claude/agents/{slug}.md`) instead of silently overwriting one another
 * (FEA-2923). Uniqueness is enforced at the DB by the partial unique index
 * `catalog_items_organization_id_agent_slug_agent_key`; this pre-check keeps
 * the common path collision-free so the P2002 retry stays rare.
 */
async function generateUniqueAgentSlug(
  tx: TransactionClient,
  organizationId: string,
  base: string
): Promise<string> {
  const exists = async (candidate: string): Promise<boolean> => {
    const found = await tx.catalogItem.findFirst({
      where: {
        organizationId,
        targetKind: "agent",
        agentSlug: candidate,
      },
      select: { id: true },
    });
    return found !== null;
  };

  if (!(await exists(base))) {
    return base;
  }
  for (let suffix = 2; suffix <= 100; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!(await exists(candidate))) {
      return candidate;
    }
  }
  throw new Error(`Could not generate unique agent slug for base "${base}"`);
}

// ---------------------------------------------------------------------------
// listAgentsForContextPack
// ---------------------------------------------------------------------------

/**
 * Returns enabled CatalogItem rows of targetKind='agent' whose sourceRepo is
 * in {"", ...repos} (org-wide agents + repo-specific agents), together with
 * the RepoBootstrapConfig critic-gates for the given repos.
 *
 * Emits the ContextPackAgent wire shape {slug, name, prompt} expected by the
 * harness. Prompt is sourced from the latest CatalogItemVersion.content
 * (content is nullable for asset-only items; items with null content are
 * excluded because the harness cannot use them).
 *
 * Semantically identical to agentsService.getContextPackData.
 */
export async function listAgentsForContextPack(
  orgId: string,
  repos?: string[]
): Promise<{
  agents: ContextPackAgent[];
  repoConfigs: ContextPackRepoConfig[];
}> {
  const sourceRepoFilter = repos ? { sourceRepo: { in: ["", ...repos] } } : {};

  const [items, repoConfigs] = await withDb((db) =>
    Promise.all([
      db.catalogItem.findMany({
        where: {
          organizationId: orgId,
          targetKind: "agent",
          enabled: true,
          archived: false,
          ...sourceRepoFilter,
        },
        select: {
          role: true,
          name: true,
          agentSlug: true,
          versions: {
            orderBy: { version: "desc" },
            take: 1,
            select: { content: true },
          },
        },
        orderBy: { role: "asc" },
      }),
      db.repoBootstrapConfig.findMany({
        where: {
          organizationId: orgId,
          ...(repos ? { repoFullName: { in: repos } } : {}),
        },
        select: { repoFullName: true, criticGates: true },
      }),
    ])
  );

  const agents: ContextPackAgent[] = [];
  for (const item of items) {
    const prompt = item.versions[0]?.content;
    if (!prompt) {
      // Asset-only items have no inline prompt; skip them for context pack
      continue;
    }
    agents.push({
      // Prefer the persisted, disambiguated slug (SSOT). Fall back to the
      // role-derived slug only for legacy rows that predate agentSlug backfill
      // — recomputing on read would re-introduce the same-role/different-repo
      // collision this column exists to prevent (FEA-2923).
      slug: item.agentSlug ?? catalogItemSlug(item.role, item.name),
      name: item.name,
      prompt,
    });
  }

  return {
    agents,
    repoConfigs: repoConfigs.map((c) => ({
      repoFullName: c.repoFullName,
      criticGates: c.criticGates as Record<string, unknown>,
    })),
  };
}

// ---------------------------------------------------------------------------
// bulkIngestAgents
// ---------------------------------------------------------------------------

type AgentIngestInput = {
  name: string;
  role: string;
  description?: string;
  prompt: string;
};

type BulkIngestInput = {
  agents: AgentIngestInput[];
  bootstrapRunId: string;
  sourceRepo: string;
  criticGates?: Record<string, unknown>;
};

export type BulkIngestCatalogItemsResult = {
  created: number;
  updated: number;
  items: Array<{ id: string; role: string | null; name: string }>;
};

/**
 * Dedup-aware transactional ingest of bootstrap-generated agents into
 * CatalogItem + CatalogItemVersion.
 *
 * Preserves exact semantics from agentsService.bulkIngest (service.ts:345):
 *   - Dedup input by role (last-wins within the batch).
 *   - Upsert by (organizationId, sourceRepo, role) unique index.
 *   - Existing → bump currentVersion via increment + new CatalogItemVersion
 *     with changeNote='Re-generated by bootstrap'.
 *   - New → create with version=1, changeNote='Initial version from bootstrap'.
 *   - criticGates → upsert RepoBootstrapConfig (table is kept).
 *
 * Returns {created, updated, items} for observability.
 */
/**
 * Max attempts for the whole ingest transaction. A retry only fires when a
 * concurrent bootstrap of the same (org, sourceRepo, role) claims the same
 * next CatalogItemVersion.version and one loses the
 * unique(catalogItemId, version) race. Bootstrap is near-single-flight, so a
 * small budget converges quickly.
 */
const MAX_INGEST_ATTEMPTS = 5;

export async function bulkIngestAgents(
  organizationId: string,
  userId: string,
  input: BulkIngestInput
): Promise<BulkIngestCatalogItemsResult> {
  // CatalogItem has no atomic integer version counter to `{ increment: 1 }`
  // (its `version` column is a semver string); the numeric version lives on
  // CatalogItemVersion and is derived as max(version)+1. Two concurrent
  // bootstraps of the same (org, sourceRepo, role) can each read the same
  // max(version) and both write max+1, colliding on the
  // unique(catalogItemId, version) index. The loser's whole interactive
  // transaction is poisoned by the P2002, so we retry the entire transaction
  // (rather than swallowing the error mid-transaction) — on retry it re-reads
  // the now-advanced max(version) and claims the next free number, restoring
  // the idempotency the old atomic-increment path had.
  for (let attempt = 0; ; attempt++) {
    try {
      return await runBulkIngestTransaction(organizationId, userId, input);
    } catch (error) {
      if (
        getPrismaErrorCode(error) === "P2002" &&
        attempt < MAX_INGEST_ATTEMPTS - 1
      ) {
        continue;
      }
      throw error;
    }
  }
}

async function runBulkIngestTransaction(
  organizationId: string,
  userId: string,
  input: BulkIngestInput
): Promise<BulkIngestCatalogItemsResult> {
  let created = 0;
  let updated = 0;
  const items: BulkIngestCatalogItemsResult["items"] = [];

  await withDb.tx(async (tx) => {
    const dedupedAgents = dedupeByRole(input.agents);
    const roles = dedupedAgents.map((a) => a.role);

    const existingItems = await findExistingByRoles(
      tx,
      organizationId,
      input.sourceRepo,
      roles
    );
    const byRole = new Map(existingItems.map((ci) => [ci.role ?? "", ci]));

    for (const agent of dedupedAgents) {
      const existing = byRole.get(agent.role);

      if (existing) {
        await updateExistingItem(
          tx,
          existing,
          agent,
          userId,
          input,
          organizationId
        );
        items.push({ id: existing.id, role: existing.role, name: agent.name });
        updated++;
      } else {
        const newItem = await createNewItem(
          tx,
          organizationId,
          userId,
          agent,
          input
        );
        items.push({ id: newItem.id, role: newItem.role, name: newItem.name });
        created++;
      }
    }

    if (input.criticGates) {
      await upsertRepoBootstrapConfig(
        tx,
        organizationId,
        input.sourceRepo,
        input.criticGates,
        input.bootstrapRunId
      );
    }
  });

  return { created, updated, items };
}

// ---------------------------------------------------------------------------
// Private helpers (extracted to keep cognitive complexity <20)
// ---------------------------------------------------------------------------

function dedupeByRole(agents: AgentIngestInput[]): AgentIngestInput[] {
  return [...new Map(agents.map((a) => [a.role, a])).values()];
}

function findExistingByRoles(
  tx: TransactionClient,
  organizationId: string,
  sourceRepo: string,
  roles: string[]
) {
  return tx.catalogItem.findMany({
    where: {
      organizationId,
      targetKind: "agent",
      sourceRepo,
      role: { in: roles },
    },
    select: {
      id: true,
      role: true,
      name: true,
      versions: {
        orderBy: { version: "desc" },
        take: 1,
        select: { version: true },
      },
    },
  });
}

async function updateExistingItem(
  tx: TransactionClient,
  existing: {
    id: string;
    role: string | null;
    versions: Array<{ version: number }>;
  },
  agent: AgentIngestInput,
  userId: string,
  input: BulkIngestInput,
  organizationId: string
) {
  const currentVersion = existing.versions[0]?.version ?? 0;
  const nextVersion = currentVersion + 1;

  await tx.catalogItem.update({
    where: { id: existing.id },
    data: {
      name: agent.name,
      description: agent.description ?? null,
      sourceLoopId: input.bootstrapRunId,
      updatedAt: new Date(),
      // Re-generated content re-derives the content-addressed identity so the
      // dedup/analytics key tracks the current body (same source/owner).
      componentUuid: deriveComponentUuid({
        content: agent.prompt,
        sourceRepo: input.sourceRepo,
        organizationId,
      }),
    },
  });

  // A concurrent bootstrap can claim this same `nextVersion` and trip the
  // unique(catalogItemId, version) index, poisoning this transaction. That
  // P2002 is caught at the transaction boundary in bulkIngestAgents, which
  // retries the whole ingest and re-reads the advanced max(version).
  await tx.catalogItemVersion.create({
    data: {
      catalogItemId: existing.id,
      version: nextVersion,
      name: agent.name,
      content: agent.prompt,
      changeNote: "Re-generated by bootstrap",
      changedById: userId,
    },
  });
}

async function createNewItem(
  tx: TransactionClient,
  organizationId: string,
  userId: string,
  agent: AgentIngestInput,
  input: BulkIngestInput
) {
  const agentSlug = await generateUniqueAgentSlug(
    tx,
    organizationId,
    catalogItemSlug(agent.role, agent.name)
  );

  const newItem = await tx.catalogItem.create({
    data: {
      organizationId,
      targetKind: "agent",
      source: "org_custom",
      scope: "org",
      name: agent.name,
      description: agent.description ?? null,
      sourceRepo: input.sourceRepo,
      role: agent.role,
      agentSlug,
      sourceLoopId: input.bootstrapRunId,
      createdById: userId,
      // Same content-addressed identity as every other content-bearing writer
      // so a bootstrap-ingested agent dedups/joins with the manually-authored
      // or promoted copy of the same file.
      componentUuid: deriveComponentUuid({
        content: agent.prompt,
        sourceRepo: input.sourceRepo,
        organizationId,
      }),
    },
    select: { id: true, role: true, name: true },
  });

  await tx.catalogItemVersion.create({
    data: {
      catalogItemId: newItem.id,
      version: 1,
      name: agent.name,
      content: agent.prompt,
      changeNote: "Initial version from bootstrap",
      changedById: userId,
    },
  });

  // FEA-2923 (Gap A, forward path): the one-time backfill migration only
  // snapshotted EXISTING org_custom agents into `agent_components` (the table
  // the Agents workspace reads via agentComponentsService.listForOrg). This
  // native creation path is the live, ongoing writer of org_custom catalog
  // items (bootstrap loop ingestion → bulkIngestAgents), so without mirroring
  // the write here every NEW org_custom agent would again have no
  // agent_components row and be invisible in the UI. Materialize the inventory
  // row now, using the same deterministic (compute_target_id, component_kind,
  // external_component_id) mapping the migration used so the two tables stay in
  // sync on write and a later backfill re-run is a no-op.
  await materializeCloudAgentComponent(tx, {
    organizationId,
    catalogItemId: newItem.id,
    name: agent.name,
    componentKey: agentSlug,
    description: agent.description ?? null,
    sourceRepo: input.sourceRepo,
    createdById: userId,
  });

  return newItem;
}

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
 * migration picks) and return its id. Runs inside the ingest transaction.
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
    // fail the whole ingest. The catalog item still lands; a later backfill
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
async function materializeCloudAgentComponent(
  tx: TransactionClient,
  params: {
    organizationId: string;
    catalogItemId: string;
    name: string;
    componentKey: string;
    description: string | null;
    sourceRepo: string;
    createdById: string;
  }
): Promise<void> {
  const sentinelId = await ensureCloudSentinelTarget(tx, params.organizationId);
  if (!sentinelId) {
    return;
  }

  const externalComponentId = `cloud:agent:${params.catalogItemId}`;
  const sourceUrl = params.sourceRepo === "" ? null : params.sourceRepo;
  const now = new Date();

  await tx.agentComponent.upsert({
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
}

async function upsertRepoBootstrapConfig(
  tx: TransactionClient,
  organizationId: string,
  repoFullName: string,
  criticGates: Record<string, unknown>,
  bootstrapRunId: string
) {
  await tx.repoBootstrapConfig.upsert({
    where: {
      organizationId_repoFullName: {
        organizationId,
        repoFullName,
      },
    },
    create: {
      organizationId,
      repoFullName,
      criticGates: criticGates as Prisma.InputJsonValue,
      bootstrapRunId,
    },
    update: {
      criticGates: criticGates as Prisma.InputJsonValue,
      bootstrapRunId,
    },
  });
}

// ---------------------------------------------------------------------------
// Catalog store methods (admin CRUD + asset management) — T-15.13
// ---------------------------------------------------------------------------

/**
 * Internal DB row shape selected for CatalogItem queries.
 * Includes `logoAssetKey` and `zipAssetKey` for S3 presigning; these are
 * not exposed in the public CatalogItemDto (only `logoUrl` is exposed).
 */
type CatalogRow = {
  id: string;
  organizationId: string | null;
  targetKind: string;
  source: string;
  scope: string;
  name: string;
  description: string | null;
  version: string;
  sortOrder: number;
  enabled: boolean;
  archived: boolean;
  coaching: boolean;
  coachingConfig: Prisma.JsonValue | null;
  agentSlug: string | null;
  parentPackId: string | null;
  componentUuid: string | null;
  zipAssetKey: string | null;
  logoAssetKey: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * CatalogItem select shape reused across list/detail queries.
 * Keeps the select DRY and avoids cognitive complexity in callers.
 */
const CATALOG_ITEM_SELECT = {
  id: true,
  organizationId: true,
  targetKind: true,
  source: true,
  scope: true,
  name: true,
  description: true,
  version: true,
  sortOrder: true,
  enabled: true,
  archived: true,
  coaching: true,
  coachingConfig: true,
  agentSlug: true,
  parentPackId: true,
  componentUuid: true,
  zipAssetKey: true,
  logoAssetKey: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Convert a raw DB row to a CatalogItemDto with `logoUrl=null`.
 * Routes call `populateLogoUrl` separately to add the presigned URL.
 */
function toCatalogItemDto(row: CatalogRow): CatalogItemDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    targetKind: row.targetKind,
    source: row.source as CatalogItemDto["source"],
    scope: row.scope as CatalogItemDto["scope"],
    name: row.name,
    description: row.description,
    version: row.version,
    sortOrder: row.sortOrder,
    enabled: row.enabled,
    archived: row.archived,
    coaching: row.coaching,
    coachingConfig:
      row.coachingConfig == null
        ? null
        : (row.coachingConfig as Record<string, unknown>),
    agentSlug: row.agentSlug,
    parentPackId: row.parentPackId,
    componentUuid: row.componentUuid,
    content: null, // populated on detail from the latest version
    components: [], // populated on detail with child component items
    logoUrl: null, // populated by populateLogoUrl
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Presigned logo-URL cache (FEA-3237)
// ---------------------------------------------------------------------------

/** Lifetime of a minted presigned logo GET URL, in seconds. */
const LOGO_URL_EXPIRY_SECONDS = 900;

/**
 * Re-mint a cached logo URL once it is within this margin of expiry, so a URL
 * handed to a client always has comfortable headroom left before the S3
 * signature expires.
 */
const LOGO_URL_CACHE_SAFETY_MARGIN_MS = 60 * 1000;

/** Cap on distinct (logoAssetKey, version) entries kept per process. */
const LOGO_URL_CACHE_MAX_ENTRIES = 10_000;

type CachedLogoUrl = { url: string; expiresAtMs: number };

/**
 * Per-process, bounded cache of presigned logo GET URLs for PLUGIN_STORE_BUCKET,
 * keyed by (logoAssetKey, versionToken). This mirrors the attachments-service
 * `getCachedSignedDownloadEntry` pattern locally rather than sharing a helper —
 * catalog logos live in a different bucket, use a different TTL, and mint via a
 * different function, so a shared abstraction was deliberately declined.
 *
 * Without this cache, `populateLogoUrl` minted a fresh 900s signature on every
 * list/detail read; because `use-catalog.ts` polls/refetches with a 0 staleTime,
 * the rotating `X-Amz-Signature` defeated the browser HTTP cache and every hot
 * logo re-downloaded from S3 on every refetch. Reusing a still-valid signature
 * keeps the `logoUrl` string stable so the browser serves the image from its own
 * cache (the mint fn sets `ResponseCacheControl`).
 *
 * The version token is the row's `updatedAt`: the logo key is a fixed path
 * (`org/<orgId>/catalog/<itemId>/logo`) that is reused on re-upload, and
 * `confirmAssetUpload` bumps `updatedAt` when the logo bytes change, so a new
 * token forces a fresh mint (and thus a fresh browser fetch). Unrelated edits
 * that also bump `updatedAt` merely trigger a harmless re-mint — never a stale
 * URL. Avoiding an S3 HeadObject per read is intentional: fetching the real ETag
 * on every listing would reintroduce the per-read S3 round-trip this fix removes.
 */
const logoUrlCache = new BoundedCache<string, CachedLogoUrl>(
  LOGO_URL_CACHE_MAX_ENTRIES
);

/**
 * Return a presigned logo GET URL, reusing a cached signature for the same
 * (logoAssetKey, versionToken) while it remains comfortably valid. Mints fresh
 * when absent, when the version token changes (logo re-uploaded), or when the
 * cached signature is within the safety margin of expiry.
 */
async function getCachedLogoUrl(
  logoAssetKey: string,
  versionToken: string
): Promise<string> {
  // Positional JSON encoding so a key that contains the delimiter cannot
  // collapse two distinct (key, version) tuples onto one cache entry.
  const cacheKey = JSON.stringify([logoAssetKey, versionToken]);
  const now = Date.now();

  const cached = logoUrlCache.get(cacheKey);
  if (cached && cached.expiresAtMs - LOGO_URL_CACHE_SAFETY_MARGIN_MS > now) {
    return cached.url;
  }

  const url = await getCatalogAssetDownloadUrl(logoAssetKey, {
    expiresIn: LOGO_URL_EXPIRY_SECONDS,
  });
  logoUrlCache.set(cacheKey, {
    url,
    expiresAtMs: now + LOGO_URL_EXPIRY_SECONDS * 1000,
  });
  return url;
}

/**
 * Populate `logoUrl` with a presigned S3 GET URL for the logo asset, reusing a
 * cached signature across reads (see {@link logoUrlCache}). Accepts an extended
 * internal shape with `logoAssetKey`; returns a plain `CatalogItemDto`
 * (logoUrl populated, internal key not exposed).
 */
async function populateLogoUrl(
  dto: CatalogItemDto,
  logoAssetKey: string | null,
  versionToken: string
): Promise<CatalogItemDto> {
  if (!logoAssetKey) {
    return dto;
  }
  try {
    const logoUrl = await getCachedLogoUrl(logoAssetKey, versionToken);
    return { ...dto, logoUrl };
  } catch (error) {
    // Non-fatal: presign failure should not block the listing response. It is
    // still an operator signal — a misconfigured bucket, rotated credentials,
    // or denied access silently degrades every catalog read to logoUrl=null,
    // so warn rather than swallow. The raw error is passed through to preserve
    // name/stack (FEA-2918).
    log.warn("catalog.logo_presign_failed", { error, logoAssetKey });
    return dto;
  }
}

/** Convert a DB row to a CatalogItemDto and populate logoUrl. */
function rowToDto(row: CatalogRow): Promise<CatalogItemDto> {
  return populateLogoUrl(
    toCatalogItemDto(row),
    row.logoAssetKey,
    // `updatedAt` is the cache version token; it bumps when the logo is
    // re-uploaded (confirmAssetUpload updates the row), invalidating the entry.
    row.updatedAt.toISOString()
  );
}

// ---------------------------------------------------------------------------
// listForOrg
// ---------------------------------------------------------------------------

type ListCatalogInput = {
  organizationId: string;
  includeArchived?: boolean;
};

/**
 * List CatalogItems visible to the org: org-specific items + curated global items.
 * Excludes archived items by default. Org-scoped (never crosses org boundary).
 */
export async function listCatalogItemsForOrg(
  input: ListCatalogInput
): Promise<CatalogItemDto[]> {
  const rows = await withDb((db) =>
    db.catalogItem.findMany({
      where: {
        archived: input.includeArchived ? undefined : false,
        // Top-level Packs + standalone items only; authored components appear
        // nested under their Pack on the detail read.
        parentPackId: null,
        OR: [
          { organizationId: input.organizationId },
          { scope: "global", source: "curated" },
        ],
      },
      select: CATALOG_ITEM_SELECT,
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    })
  );

  return Promise.all(rows.map(rowToDto));
}

// ---------------------------------------------------------------------------
// getDetail
// ---------------------------------------------------------------------------

type GetCatalogDetailInput = {
  id: string;
  organizationId: string;
};

type GetCatalogDetailError = 404;

/**
 * Return a single CatalogItem by id, scoped to the calling org.
 * Curated items are visible to all orgs; org_custom items are org-private.
 */
export async function getCatalogItemDetail(
  input: GetCatalogDetailInput
): Promise<Result<CatalogItemDto, GetCatalogDetailError>> {
  const data = await withDb(async (db) => {
    const row = await db.catalogItem.findFirst({
      where: {
        id: input.id,
        OR: [
          { organizationId: input.organizationId },
          { scope: "global", source: "curated" },
        ],
      },
      select: CATALOG_ITEM_SELECT,
    });
    if (!row) {
      return null;
    }
    // Latest authored body for this item + each of its child components.
    const latest = await db.catalogItemVersion.findFirst({
      where: { catalogItemId: row.id },
      orderBy: { version: "desc" },
      select: { content: true },
    });
    // Scope children to the SAME visibility predicate as the parent
    // (org-owned OR curated/global). A component written under this pack id by a
    // foreign org must never surface in this org's detail read: without this
    // filter, org A could attach a child under any pack id it can name and have
    // it render in every other org's detail (cross-org child leak).
    const childRows = await db.catalogItem.findMany({
      where: {
        parentPackId: row.id,
        archived: false,
        OR: [
          { organizationId: input.organizationId },
          { scope: "global", source: "curated" },
        ],
      },
      select: CATALOG_ITEM_SELECT,
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    const childContents = await Promise.all(
      childRows.map((child) =>
        db.catalogItemVersion.findFirst({
          where: { catalogItemId: child.id },
          orderBy: { version: "desc" },
          select: { content: true },
        })
      )
    );
    return {
      row,
      content: latest?.content ?? null,
      childRows,
      childContents,
    };
  });

  if (!data) {
    return Result.err(404);
  }

  const dto = await rowToDto(data.row);
  const components = await Promise.all(
    data.childRows.map(async (child, index) => {
      const childDto = await rowToDto(child);
      return {
        ...childDto,
        content: data.childContents[index]?.content ?? null,
      };
    })
  );

  return Result.ok({ ...dto, content: data.content, components });
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

type CreateCatalogInput = {
  organizationId: string;
  userId: string;
  targetKind: string;
  name: string;
  description?: string;
  sortOrder?: number;
  coaching?: boolean;
  coachingConfig?: Record<string, unknown>;
  /** Parent Pack id when creating a component inside a Pack. */
  parentPackId?: string;
  /** Authored `.md` / config body persisted as the item's first version. */
  content?: string;
  /** Provenance for the content-addressed identity (e.g. repo full name). */
  sourceRepo?: string;
};

type CreateCatalogError = 404 | 403;

/**
 * Create a single org-scoped CatalogItem within an existing transaction.
 *
 * Factored out of `createCatalogItem` so other transactional writers (e.g. the
 * zip-import loop) can create components inside their own `tx` without a nested
 * transaction — keeping the create + first-version + agent-materialization
 * atomic with the surrounding work and avoiding duplicating this logic.
 *
 * When `parentPackId` is present, the referenced parent must exist, be a Pack
 * container (`targetKind === "pack"`), and belong to the caller's org. This
 * prevents attaching a component under a curated/global or foreign-org pack id
 * (a cross-org child leak): otherwise org A could write a child under any pack
 * id it can name and have it surface in every org's detail read (see the
 * matching visibility filter in `getCatalogItemDetail`). Returns 404 when the
 * parent is missing / not visible to the org, 403 when it exists but is not an
 * org-owned Pack the caller may attach to.
 *
 * `skipParentValidation` lets a caller that has ALREADY confirmed the parent is
 * an org-owned Pack (e.g. the zip-import path validates the pack once upfront)
 * avoid a redundant per-child lookup. It must never be set on an untrusted
 * `parentPackId` such as one taken straight from a request body.
 */
async function createCatalogItemInTx(
  tx: TransactionClient,
  input: CreateCatalogInput,
  options: { skipParentValidation?: boolean } = {}
): Promise<Result<CatalogRow, CreateCatalogError>> {
  // Validate the parent Pack (when attaching a component) BEFORE inserting the
  // child so a foreign-org / curated / non-pack parent is rejected atomically.
  if (input.parentPackId != null && !options.skipParentValidation) {
    const parent = await tx.catalogItem.findFirst({
      where: { id: input.parentPackId },
      select: { id: true, organizationId: true, targetKind: true },
    });
    if (!parent || parent.organizationId !== input.organizationId) {
      // Missing, or a curated/global/foreign-org pack the caller can't see.
      return Result.err<CatalogRow, CreateCatalogError>(404);
    }
    if (parent.targetKind !== "pack") {
      // Exists in the org but is not a Pack container → can't hold children.
      return Result.err<CatalogRow, CreateCatalogError>(403);
    }
  }

  const created = await tx.catalogItem.create({
    data: {
      organizationId: input.organizationId,
      targetKind: input.targetKind,
      source: "org_custom",
      scope: "org",
      name: input.name,
      description: input.description ?? null,
      sortOrder: input.sortOrder ?? 0,
      coaching: input.coaching ?? false,
      coachingConfig:
        input.coachingConfig == null
          ? undefined
          : (input.coachingConfig as Prisma.InputJsonValue),
      parentPackId: input.parentPackId ?? null,
      sourceRepo: input.sourceRepo ?? null,
      // Content-addressed identity for authored/imported components.
      componentUuid: deriveComponentUuid({
        content: input.content,
        sourceRepo: input.sourceRepo,
        organizationId: input.organizationId,
      }),
      createdById: input.userId,
    },
    select: CATALOG_ITEM_SELECT,
  });

  // Persist the authored body as the item's first version so it is versioned
  // from creation (each later edit appends a new CatalogItemVersion).
  if (input.content != null) {
    await tx.catalogItemVersion.create({
      data: {
        catalogItemId: created.id,
        version: 1,
        name: input.name,
        content: input.content,
        changedById: input.userId,
      },
    });
  }

  // FEA-2923 (Gap A, second forward path): POST /catalog is the other live
  // writer of org_custom agents (alongside bulkIngestAgents -> createNewItem).
  // Mirror the same materialization so a POST-created org_custom agent also
  // gets an agent_components row (owned by the org's cloud sentinel target)
  // and is visible in the Agents workspace — using the identical deterministic
  // (compute_target_id, 'subagent', 'cloud:agent:<id>') mapping the backfill
  // migration and createNewItem use, so the two tables stay in sync on write
  // and a later backfill re-run is a no-op. This admin-create path has no
  // agentSlug, so componentKey falls back to the agent name in the helper.
  if (created.targetKind === "agent") {
    await materializeCloudAgentComponent(tx, {
      organizationId: input.organizationId,
      catalogItemId: created.id,
      name: input.name,
      componentKey: input.name,
      description: input.description ?? null,
      sourceRepo: "",
      createdById: input.userId,
    });
  }

  return Result.ok<CatalogRow, CreateCatalogError>(created);
}

/**
 * Create a new org-scoped CatalogItem.
 * Source is always `org_custom`; scope is always `org`.
 * Curated items are seeded via database seed scripts, not this endpoint.
 *
 * When `parentPackId` is present, the referenced parent must exist, be a Pack
 * container (`targetKind === "pack"`), and belong to the caller's org. This
 * prevents attaching a component under a curated/global or foreign-org pack id
 * (a cross-org child leak): otherwise org A could write a child under any pack
 * id it can name and have it surface in every org's detail read (see the
 * matching visibility filter in `getCatalogItemDetail`). Returns 404 if the
 * parent is missing / not visible to the org, 403 if it exists but is not an
 * org-owned Pack the caller may attach to.
 */
export async function createCatalogItem(
  input: CreateCatalogInput
): Promise<Result<CatalogItemDto, CreateCatalogError>> {
  // Runs in a transaction so that, for agent items, the agent_components
  // inventory row is materialized atomically with the catalog row.
  // ensureCloudSentinelTarget (inside materializeCloudAgentComponent) may
  // create the org's sentinel compute target and therefore needs the tx.
  const result = await withDb.tx((tx) => createCatalogItemInTx(tx, input));

  if (!result.ok) {
    return result;
  }
  const dto = await rowToDto(result.value);
  return Result.ok(dto);
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

type UpdateCatalogInput = {
  id: string;
  organizationId: string;
  userId: string;
  canUpdateAny?: boolean;
  name?: string;
  description?: string;
  sortOrder?: number;
  enabled?: boolean;
  coaching?: boolean;
  coachingConfig?: Record<string, unknown>;
  /** New authored body; appended as a new CatalogItemVersion when present. */
  content?: string;
};

type UpdateCatalogError = 404 | 403;

/**
 * Update mutable fields on a CatalogItem.
 * Admins can update every mutable field on org-owned custom items. Non-admin
 * creators can update only item metadata and authored content for content
 * bearing target kinds. Read-only sources, archived rows, and foreign-org items
 * fail closed.
 */
export async function updateCatalogItem(
  input: UpdateCatalogInput
): Promise<Result<CatalogItemDto, UpdateCatalogError>> {
  // Look up through the visible catalog predicate so readable read-only
  // sources return 403 while foreign org-owned rows remain hidden as 404.
  const existing = await withDb((db) =>
    db.catalogItem.findFirst({
      where: {
        id: input.id,
        OR: [
          { organizationId: input.organizationId },
          { scope: "global", source: CatalogItemSource.Curated },
        ],
      },
      select: {
        id: true,
        source: true,
        archived: true,
        targetKind: true,
        organizationId: true,
        createdById: true,
        sourceRepo: true,
      },
    })
  );

  if (!existing) {
    return Result.err(404);
  }
  if (
    existing.source !== CatalogItemSource.OrgCustom ||
    existing.archived ||
    !canUpdateCatalogItem(existing, input)
  ) {
    return Result.err(403);
  }

  const updatedResult = await withDb.tx(async (tx) => {
    const update = await tx.catalogItem.updateMany({
      where: catalogItemUpdateWhere(input),
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && {
          description: input.description,
        }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
        ...(input.enabled !== undefined && { enabled: input.enabled }),
        ...(input.coaching !== undefined && { coaching: input.coaching }),
        ...(input.coachingConfig !== undefined && {
          coachingConfig: input.coachingConfig as Prisma.InputJsonValue,
        }),
        // Content-addressed identity tracks the current content; editing the
        // body re-derives it (same source/owner provenance).
        ...(input.content !== undefined && {
          componentUuid: deriveComponentUuid({
            content: input.content,
            sourceRepo: existing.sourceRepo,
            organizationId: input.organizationId,
          }),
        }),
      },
    });
    if (update.count !== 1) {
      return Result.err<CatalogRow, UpdateCatalogError>(403);
    }

    const row = await tx.catalogItem.findUnique({
      where: { id: input.id },
      select: CATALOG_ITEM_SELECT,
    });
    if (!row) {
      return Result.err<CatalogRow, UpdateCatalogError>(404);
    }

    // A new authored body appends a new version (monotonic max+1), so edits are
    // a versioned artifact history rather than an in-place overwrite.
    if (input.content !== undefined) {
      const last = await tx.catalogItemVersion.findFirst({
        where: { catalogItemId: input.id },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      await tx.catalogItemVersion.create({
        data: {
          catalogItemId: input.id,
          version: (last?.version ?? 0) + 1,
          name: row.name,
          content: input.content,
          changedById: input.userId,
        },
      });
    }

    return Result.ok<CatalogRow, UpdateCatalogError>(row);
  });

  if (!updatedResult.ok) {
    return updatedResult;
  }

  const dto = await rowToDto(updatedResult.value);
  return Result.ok(dto);
}

type UpdateCatalogAuthorizationRow = {
  source: string;
  archived: boolean;
  targetKind: string;
  organizationId: string | null;
  createdById: string | null;
};

const CatalogTargetKind = {
  Agent: "agent",
  Command: "command",
  Hook: "hook",
  Mcp: "mcp",
  Pack: "pack",
  Plugin: "plugin",
  Skill: "skill",
} as const;

function canUpdateCatalogItem(
  row: UpdateCatalogAuthorizationRow,
  input: UpdateCatalogInput
): boolean {
  if (input.content !== undefined && !canUpdateContent(row.targetKind)) {
    return false;
  }
  if (input.canUpdateAny === true) {
    return true;
  }
  if (row.createdById !== input.userId) {
    return false;
  }
  return !hasAdminOnlyUpdateFields(input);
}

function hasAdminOnlyUpdateFields(input: UpdateCatalogInput): boolean {
  return (
    input.sortOrder !== undefined ||
    input.enabled !== undefined ||
    input.coaching !== undefined ||
    input.coachingConfig !== undefined
  );
}

function canUpdateContent(targetKind: string): boolean {
  switch (targetKind) {
    case CatalogTargetKind.Agent:
    case CatalogTargetKind.Command:
    case CatalogTargetKind.Hook:
    case CatalogTargetKind.Mcp:
    case CatalogTargetKind.Plugin:
    case CatalogTargetKind.Skill:
      return true;
    default:
      return false;
  }
}

function catalogItemUpdateWhere(
  input: UpdateCatalogInput
): Prisma.CatalogItemWhereInput {
  const where: Prisma.CatalogItemWhereInput = {
    id: input.id,
    organizationId: input.organizationId,
    source: CatalogItemSource.OrgCustom,
    archived: false,
  };
  if (input.canUpdateAny !== true) {
    where.createdById = input.userId;
  }
  return where;
}

// ---------------------------------------------------------------------------
// archive
// ---------------------------------------------------------------------------

type ArchiveCatalogInput = {
  id: string;
  organizationId: string;
};

type ArchiveCatalogError = 404 | 403;

/**
 * Soft-archive a CatalogItem (sets archived=true).
 * Curated items cannot be archived by orgs (403).
 */
export async function archiveCatalogItem(
  input: ArchiveCatalogInput
): Promise<Result<{ archived: true }, ArchiveCatalogError>> {
  const existing = await withDb((db) =>
    db.catalogItem.findFirst({
      where: { id: input.id, organizationId: input.organizationId },
      select: { id: true, source: true },
    })
  );

  if (!existing) {
    return Result.err(404);
  }
  if (existing.source === "curated") {
    return Result.err(403);
  }

  await withDb((db) =>
    db.catalogItem.update({
      where: { id: input.id },
      data: { archived: true },
    })
  );

  return Result.ok({ archived: true });
}

// ---------------------------------------------------------------------------
// import from zip
// ---------------------------------------------------------------------------

type ImportPackZipInput = {
  id: string;
  organizationId: string;
  userId: string;
};

/** 404 not found · 403 curated · 400 no zip uploaded · 413 zip over size/entry budget. */
type ImportPackZipError = 404 | 403 | 400 | 413;

export type ImportPackZipResult = {
  created: number;
  skipped: number;
  /** Recognized entries dropped because they failed create-path validation. */
  invalid: number;
};

/**
 * Create each parsed component under the Pack, skipping ones already present
 * (by kind + name). Shared by the zip and repo import paths so both inherit the
 * same validation, atomicity, and cross-org guards.
 *
 * SECURITY PRECONDITION: the caller MUST have already confirmed `input.id` is an
 * org-owned Pack container (`organizationId === input.organizationId` AND
 * `targetKind === "pack"`) before invoking this helper — both import callers do
 * that upfront. This helper passes `skipParentValidation` to
 * `createCatalogItemInTx`, so it does NOT re-check the parent per child; calling
 * it with a request-derived / unvalidated pack id would reintroduce the
 * cross-org child-leak that the per-child parent validation otherwise closes.
 *
 * Validation: each recognized entry is only persisted after it passes the same
 * `createCatalogItemBodySchema` the manual POST /catalog path enforces (name
 * length + 1 MB content cap), so an oversized/malformed entry is rejected
 * (counted as `invalid`) instead of persisting an unusable component version.
 *
 * Atomicity: the existing-children read and every child create run inside one
 * `withDb.tx`, and the dedupe set is (re)built from the children read *inside*
 * that transaction. So a retried POST or a concurrent second import re-reads the
 * committed children and skips what the first run already wrote, rather than
 * racing on a stale pre-transaction snapshot and double-inserting. Each child is
 * created via `createCatalogItemInTx` so it is versioned from creation and — for
 * agents — materialized in `agent_components`.
 */
async function createPackComponents(
  input: { id: string; organizationId: string; userId: string },
  components: ReadonlyArray<{ kind: string; name: string; content: string }>
): Promise<ImportPackZipResult> {
  // Validate every recognized entry against the same schema the manual create
  // path uses before we open a write transaction. Invalid entries (oversized
  // content, out-of-range name) are dropped rather than persisted as unusable
  // component versions; valid ones carry their parsed shape forward.
  let invalid = 0;
  const validComponents: { kind: string; name: string; content: string }[] = [];
  for (const component of components) {
    // Validate only the source-derived (user-controlled) fields against the same
    // schema the manual create path enforces. `parentPackId` is the already
    // looked-up pack's id (trusted) and is intentionally not re-validated here.
    const parsed = createCatalogItemBodySchema.safeParse({
      targetKind: component.kind,
      name: component.name,
      content: component.content,
    });
    if (parsed.success) {
      validComponents.push(component);
    } else {
      invalid++;
    }
  }

  const { created, skipped } = await withDb.tx(async (tx) => {
    // Read the current children *inside* the transaction so the dedupe set
    // reflects what is already committed (including rows a concurrent/earlier
    // import wrote), making re-runs idempotent against duplicate children.
    const existing = await tx.catalogItem.findMany({
      where: { parentPackId: input.id },
      select: { name: true, targetKind: true },
    });
    const existingKeys = new Set(
      existing.map((item) => `${item.targetKind}:${item.name.toLowerCase()}`)
    );

    let createdCount = 0;
    let skippedCount = 0;
    for (const component of validComponents) {
      const key = `${component.kind}:${component.name.toLowerCase()}`;
      if (existingKeys.has(key)) {
        skippedCount++;
        continue;
      }
      existingKeys.add(key);
      // The pack was already validated by the caller (org-owned,
      // targetKind==="pack"), so skip the redundant per-child parent lookup.
      // Passing a request-derived parentPackId here without that upfront check
      // would be unsafe (cross-org child leak).
      const childResult = await createCatalogItemInTx(
        tx,
        {
          organizationId: input.organizationId,
          userId: input.userId,
          targetKind: component.kind,
          name: component.name,
          parentPackId: input.id,
          content: component.content,
        },
        { skipParentValidation: true }
      );
      // With validation skipped this can't return an error, but consume the
      // Result explicitly so a future change can't silently miscount.
      if (!childResult.ok) {
        throw new Error(
          `Pack component import failed parent validation (status ${childResult.error}) for pack ${input.id}`
        );
      }
      createdCount++;
    }

    return { created: createdCount, skipped: skippedCount };
  });

  return { created, skipped, invalid };
}

/**
 * Parse the Pack's uploaded zip (canonical Claude Code layout) and create a
 * child component for each recognized file, skipping components already present
 * (by kind + name). Delegates to `createPackComponents`, which validates each
 * entry against `createCatalogItemBodySchema` (name length + 1 MB content cap,
 * counting rejects as `invalid`) and creates the survivors atomically via
 * `createCatalogItemInTx` — versioned from creation and, for agents,
 * materialized in `agent_components`. The pack is validated as an org-owned Pack
 * container upfront here so the shared helper can skip the redundant per-child
 * parent lookup.
 */
export async function importPackZipComponents(
  input: ImportPackZipInput
): Promise<Result<ImportPackZipResult, ImportPackZipError>> {
  const pack = await withDb((db) =>
    db.catalogItem.findFirst({
      where: { id: input.id, organizationId: input.organizationId },
      select: {
        id: true,
        source: true,
        targetKind: true,
        zipAssetKey: true,
        zipAssetBucket: true,
      },
    })
  );

  if (!pack) {
    return Result.err(404);
  }
  if (pack.source === "curated") {
    return Result.err(403);
  }
  // Only a Pack container can hold child components; validating org-ownership +
  // targetKind here lets the shared createPackComponents helper safely skip the
  // per-child parentPackId lookup (see its SECURITY PRECONDITION).
  if (pack.targetKind !== "pack") {
    return Result.err(403);
  }
  if (!pack.zipAssetKey) {
    return Result.err(400);
  }

  // The download (raw-byte cap) and the parse (decompressed-size + entry-count
  // budget) both throw a typed too-large error on a zip-bomb / oversized asset;
  // map those to 413 so the worker returns a clear 4xx instead of buffering an
  // unbounded object / inflating to OOM and crashing (FEA-3213).
  let components: ParsedComponent[];
  try {
    const buffer = await getCatalogAssetBytes(
      pack.zipAssetKey,
      pack.zipAssetBucket ?? undefined
    );
    components = parsePackZip(buffer);
  } catch (error) {
    if (
      error instanceof PackZipTooLargeError ||
      error instanceof CatalogAssetTooLargeError
    ) {
      return Result.err(413);
    }
    throw error;
  }

  const result = await createPackComponents(input, components);
  return Result.ok(result);
}

// ---------------------------------------------------------------------------
// import from repo (.claude)
// ---------------------------------------------------------------------------

type ImportPackRepoInput = {
  id: string;
  organizationId: string;
  userId: string;
  repoFullName: string;
  ref?: string;
  subPath?: string;
};

/** 404 pack not found · 403 curated / not a Pack · 400 repo not visible. */
type ImportPackRepoError = 404 | 403 | 400;

/**
 * Import components from a GitHub repo the org has App visibility to (canonical
 * Claude Code layout — `/agents`, `/skills`, `/commands`, hooks, `.mcp.json`,
 * optionally under a `.claude` subpath). For orgs distributing a central
 * shared-asset repo. Reuses `createPackComponents` so imports inherit the same
 * validation, atomicity, and cross-org guards as the zip path.
 */
export async function importPackRepoComponents(
  input: ImportPackRepoInput
): Promise<Result<ImportPackZipResult, ImportPackRepoError>> {
  const pack = await withDb((db) =>
    db.catalogItem.findFirst({
      where: { id: input.id, organizationId: input.organizationId },
      select: { id: true, source: true, targetKind: true },
    })
  );

  if (!pack) {
    return Result.err(404);
  }
  if (pack.source === "curated") {
    return Result.err(403);
  }
  // Only a Pack container can hold child components; validating org-ownership +
  // targetKind here lets the shared createPackComponents helper safely skip the
  // per-child parentPackId lookup (see its SECURITY PRECONDITION). Without this,
  // the repo-import path would reintroduce the cross-org child-leak the per-child
  // parent validation otherwise closes.
  if (pack.targetKind !== "pack") {
    return Result.err(403);
  }

  const repoRow = await withDb((db) =>
    db.gitHubInstallationRepository.findFirst({
      where: {
        fullName: input.repoFullName,
        removedAt: null,
        installation: {
          organizationId: input.organizationId,
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      select: {
        owner: true,
        name: true,
        installation: { select: { installationId: true } },
      },
    })
  );

  if (!repoRow) {
    return Result.err(400);
  }

  const components = await fetchRepoComponents({
    installationId: repoRow.installation.installationId,
    owner: repoRow.owner,
    repo: repoRow.name,
    ref: input.ref,
    subPath: input.subPath,
  });

  const result = await createPackComponents(input, components);
  return Result.ok(result);
}

// ---------------------------------------------------------------------------
// uploadIntent (presigned S3 PUT)
// ---------------------------------------------------------------------------

/** Max zip bundle size: 50 MB */
const ZIP_MAX_BYTES = 50 * 1024 * 1024;
/** Max logo image size: 2 MB */
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Per-fileType MIME allowlist for presigned-PUT uploads. The requested
 * contentType is baked verbatim into the presigned URL's ContentType (and thus
 * the stored object's Content-Type), so an unrestricted value would let an
 * authenticated admin store e.g. `text/html`/`image/svg+xml` in the catalog
 * bucket and have S3 serve it inline — a stored-XSS / content-spoofing vector.
 * Constrain each fileType to the content types the feature actually uploads.
 */
const ALLOWED_CONTENT_TYPES: Record<"zip" | "logo", ReadonlySet<string>> = {
  zip: new Set([
    "application/zip",
    "application/x-zip-compressed",
    "application/octet-stream",
  ]),
  logo: new Set(["image/png", "image/jpeg", "image/webp"]),
};

/** Normalize a request Content-Type to its bare, lowercased media type. */
function normalizeContentType(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

type UploadIntentInput = {
  organizationId: string;
  catalogItemId: string;
  fileType: "zip" | "logo";
  contentType: string;
  fileSizeBytes: number;
};

type UploadIntentError = 404 | 403 | 413 | 415;

/**
 * Generate a presigned S3 PUT URL for a catalog asset upload.
 * Enforces per-type size caps (zip ≤ 50 MB, logo ≤ 2 MB) and a per-fileType
 * MIME allowlist (returns 415 for a disallowed contentType).
 * Returns the upload URL and the S3 key; the caller PUTs bytes to the URL
 * and then calls confirmUpload to record the key in DB.
 */
export async function getUploadIntent(
  input: UploadIntentInput
): Promise<Result<{ presignedUrl: string; s3Key: string }, UploadIntentError>> {
  const maxBytes = input.fileType === "zip" ? ZIP_MAX_BYTES : LOGO_MAX_BYTES;
  if (input.fileSizeBytes > maxBytes) {
    return Result.err(413);
  }

  // Reject any content type outside the per-fileType allowlist before it can be
  // signed into the presigned PUT (prevents storing attacker-chosen media types
  // like text/html or image/svg+xml in the catalog bucket).
  if (
    !ALLOWED_CONTENT_TYPES[input.fileType].has(
      normalizeContentType(input.contentType)
    )
  ) {
    return Result.err(415);
  }

  const existing = await withDb((db) =>
    db.catalogItem.findFirst({
      where: { id: input.catalogItemId, organizationId: input.organizationId },
      select: { id: true, source: true },
    })
  );

  if (!existing) {
    return Result.err(404);
  }
  if (existing.source === "curated") {
    return Result.err(403);
  }

  const kind = input.fileType === "zip" ? ("zip" as const) : ("logo" as const);
  const { uploadUrl, key } = await getCatalogAssetUploadUrl({
    orgId: input.organizationId,
    itemId: input.catalogItemId,
    kind,
    contentType: input.contentType,
    contentLength: input.fileSizeBytes,
    expiresIn: 900,
  });

  return Result.ok({ presignedUrl: uploadUrl, s3Key: key });
}

// ---------------------------------------------------------------------------
// confirmUpload (HeadObject + DB update)
// ---------------------------------------------------------------------------

type ConfirmUploadInput = {
  organizationId: string;
  catalogItemId: string;
  fileType: "zip" | "logo";
  s3Key: string;
};

type ConfirmUploadError = 404 | 403 | "asset_not_found";

/**
 * Verify a previously-PUT catalog asset exists in S3 (HeadObject) and record
 * its key in the CatalogItem row. Returns the updated CatalogItemDto on success.
 */
export async function confirmAssetUpload(
  input: ConfirmUploadInput
): Promise<Result<CatalogItemDto, ConfirmUploadError>> {
  const existing = await withDb((db) =>
    db.catalogItem.findFirst({
      where: { id: input.catalogItemId, organizationId: input.organizationId },
      select: { id: true, source: true },
    })
  );

  if (!existing) {
    return Result.err(404);
  }
  if (existing.source === "curated") {
    return Result.err(403);
  }

  // Validate the key prefix matches the expected pattern to prevent key hijack.
  const expectedPrefix = catalogAssetKey(
    input.organizationId,
    input.catalogItemId,
    input.fileType === "zip" ? "zip" : "logo"
  );
  if (input.s3Key !== expectedPrefix) {
    return Result.err("asset_not_found");
  }

  const assetMeta = await headCatalogAsset(input.s3Key);
  if (!assetMeta) {
    return Result.err("asset_not_found");
  }

  // Persist the resolved PLUGIN_STORE_BUCKET alongside the key so download-URL
  // builders (e.g. distributionsService.buildAssetDownloadUrl) can resolve the
  // correct bucket instead of falling back to FILE_ATTACHMENTS_BUCKET.
  const assetBucket = resolveCatalogBucket();
  const updateData =
    input.fileType === "zip"
      ? { zipAssetBucket: assetBucket, zipAssetKey: input.s3Key }
      : { logoAssetBucket: assetBucket, logoAssetKey: input.s3Key };

  const updated = await withDb((db) =>
    db.catalogItem.update({
      where: { id: input.catalogItemId },
      data: updateData,
      select: CATALOG_ITEM_SELECT,
    })
  );

  const dto = await rowToDto(updated);
  return Result.ok(dto);
}
