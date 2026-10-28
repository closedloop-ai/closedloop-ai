import "server-only";
import {
  type CatalogItemDto,
  CatalogItemSource,
  type ImportPackZipResponse,
} from "@repo/api/src/types/distribution";
import { Result, Status } from "@repo/api/src/types/result";
import {
  CatalogAssetTooLargeError,
  catalogAssetKey,
  getCatalogAssetBytes,
  getCatalogAssetDownloadUrl,
  getCatalogAssetUploadUrl,
  headCatalogAsset,
  resolveCatalogBucket,
} from "@repo/aws/catalog-assets";
import {
  GitHubInstallationStatus,
  Prisma,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { BoundedMap } from "@repo/lib/bounded-map";
import { log } from "@repo/observability/log";
import { v7 as uuidv7 } from "uuid";
import {
  materializeCloudAgentComponent,
  materializeCloudAgentComponentsBatch,
} from "@/app/catalog/service/cloud-agent-component";
import { linkPackMemberDefinition } from "@/app/catalog/service/pack-definition-link";
import {
  canUpdateCatalogItem,
  catalogItemUpdateWhere,
  isImmutableCatalogItemUpdate,
  type UpdateCatalogError,
  type UpdateCatalogInput,
  updateRefusalStatus,
} from "@/app/catalog/service/update-authorization";
import type { SearchProjectionInput } from "@/app/search/search-index-service";
import type { OrganizationWriteOutcome } from "@/lib/organization-write-receipt";
import {
  type RecordWriteInTransaction,
  writeRecorded,
} from "@/lib/record-write-in-transaction";
import { CatalogAssetError, type ConfirmUploadError } from "./asset-errors";
import { flushCatalogSearchIndex } from "./catalog-search-index";
import { deriveComponentUuid } from "./component-uuid";
import type { ParsedComponent } from "./pack-component-parse";
import { fetchRepoComponents } from "./pack-repo-import";
import { PackZipTooLargeError, parsePackZip } from "./pack-zip-import";
import { createCatalogItemBodySchema } from "./validators";

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
const logoUrlCache = new BoundedMap<string, CachedLogoUrl>(
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

type LatestChildContentRow = {
  catalogItemId: string;
  content: string | null;
};

/**
 * Resolve the latest authored body for each child component, keyed by child id.
 *
 * One query, not one per child (FEA-3299). The previous shape issued a
 * `findFirst` per child inside `Promise.all`, and because `withDb` hands back the
 * pooled client rather than holding a connection, each of those borrowed its own
 * pg connection. A pack can carry ~300 components via repo import
 * (`MAX_COMPONENT_FILES`) or ~5000 via zip (`ZIP_MAX_ENTRIES`), and this read has
 * no cap, so a single `GET /catalog/{id}` could demand many times the whole
 * 20-connection pool and starve every other route — the 2026-07-15 outage shape
 * (PRD-528).
 *
 * `DISTINCT ON` collapses the unbounded version history to the latest row per
 * child in the DB, mirroring `judges-analytics/service.ts`. Fetching every
 * version with `findMany` and reducing in memory would also remove the fan-out,
 * but `CatalogItemVersion.content` is `@db.Text` and version history is
 * unbounded, so it would ship every revision's full body to keep only the newest
 * — trading pooled connections for transfer and heap.
 *
 * Ordering is by `version DESC`, not `createdAt`: `version` is the authored
 * revision identity and carries the `@@unique([catalogItemId, version])`.
 *
 * Org-scoping: the join re-asserts the caller's visibility predicate (org-owned
 * OR curated/global) rather than trusting that `childIds` were already filtered.
 * The ids ARE pre-authorized by `childRows` below, so this is redundant today —
 * deliberately. `catalog_item_versions` carries no `organization_id` of its own
 * (its scope is inherited through `catalog_items`), and a cross-org content leak
 * is the exact failure this route's child filter exists to prevent, so the
 * invariant must not rest on caller discipline: `apps/api/AGENTS.md` says org
 * scoping takes no "trust the caller" patterns.
 *
 * Only the *security* half is re-asserted. `parentPackId` / `archived` are
 * filtering, not authorization, and stay solely on `childRows` — duplicating
 * those here would create two predicates that can drift.
 *
 * `organization_id` is nullable (curated/global rows have none), so
 * `= ${organizationId}` is NULL → false for them and the second branch is what
 * admits them — mirroring the Prisma `OR` exactly.
 *
 * The ids bind as a single `uuid[]` parameter via `= ANY(...)` rather than the
 * `IN (${Prisma.join(...)})` form used elsewhere in this app: a pack can hold
 * thousands of components (`ZIP_MAX_ENTRIES`), and one array parameter stays
 * flat where `Prisma.join` would emit one bind parameter per child and push
 * toward Postgres's parameter ceiling — the reason other call sites have to
 * chunk. `db.$queryRaw` is available on `TransactionClient` (it is not on
 * Prisma's interactive-transaction deny list).
 */
async function fetchLatestContentByChildId(
  db: TransactionClient,
  childIds: string[],
  organizationId: string
): Promise<Map<string, string | null>> {
  if (childIds.length === 0) {
    return new Map();
  }
  const rows = await db.$queryRaw<LatestChildContentRow[]>(Prisma.sql`
    SELECT DISTINCT ON (v."catalog_item_id")
      v."catalog_item_id" AS "catalogItemId",
      v."content" AS "content"
    FROM "catalog_item_versions" v
    JOIN "catalog_items" c ON c."id" = v."catalog_item_id"
    WHERE v."catalog_item_id" = ANY(${childIds}::uuid[])
      AND (
        c."organization_id" = ${organizationId}::uuid
        OR (c."scope" = 'global' AND c."source" = 'curated')
      )
    ORDER BY v."catalog_item_id", v."version" DESC
  `);
  return new Map(rows.map((r) => [r.catalogItemId, r.content]));
}

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
    const contentByChildId = await fetchLatestContentByChildId(
      db,
      childRows.map((child) => child.id),
      input.organizationId
    );
    return {
      row,
      content: latest?.content ?? null,
      childRows,
      contentByChildId,
    };
  });

  if (!data) {
    return Result.err(404);
  }

  const dto = await rowToDto(data.row);
  const components = await Promise.all(
    data.childRows.map(async (child) => {
      const childDto = await rowToDto(child);
      return {
        ...childDto,
        content: data.contentByChildId.get(child.id) ?? null,
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
  options: {
    skipParentValidation?: boolean;
    // FEA-4011 Slice A: the materialized agent component's search projection is
    // pushed here for the top-level caller to flush fail-open after commit.
    pendingSearchIndex?: SearchProjectionInput[];
  } = {}
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
    const version = await tx.catalogItemVersion.create({
      data: {
        catalogItemId: created.id,
        version: 1,
        name: input.name,
        content: input.content,
        changedById: input.userId,
      },
      select: { id: true },
    });
    // FEA-3909 (F4): a content-bearing PACK MEMBER links its exact body to the
    // F1 registry and records a `pack` occurrence. Standalone (non-pack) items
    // are out of F4 scope — only members inside a Pack get the pack seam.
    if (input.parentPackId != null) {
      await linkPackMemberDefinition(tx, {
        organizationId: input.organizationId,
        packId: input.parentPackId,
        catalogItemVersionId: version.id,
        targetKind: input.targetKind,
        content: input.content,
      });
    }
  }

  // FEA-2923 (Gap A, forward path): POST /catalog is the live writer of
  // org_custom agents. Materialize an agent_components row (owned by the org's
  // cloud sentinel target) so a POST-created org_custom agent is visible in the
  // Agents workspace — using the identical deterministic
  // (compute_target_id, 'subagent', 'cloud:agent:<id>') mapping the backfill
  // migration uses, so the two tables stay in sync on write
  // and a later backfill re-run is a no-op. This admin-create path has no
  // agentSlug, so componentKey falls back to the agent name in the helper.
  if (created.targetKind === "agent") {
    await materializeCloudAgentComponent(
      tx,
      {
        organizationId: input.organizationId,
        catalogItemId: created.id,
        name: input.name,
        componentKey: input.name,
        description: input.description ?? null,
        sourceRepo: "",
        createdById: input.userId,
      },
      options.pendingSearchIndex
    );
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
  input: CreateCatalogInput,
  recordWrite?: RecordWriteInTransaction<OrganizationWriteOutcome>
): Promise<Result<CatalogItemDto, CreateCatalogError>> {
  // Runs in a transaction so that, for agent items, the agent_components
  // inventory row is materialized atomically with the catalog row.
  // ensureCloudSentinelTarget (inside materializeCloudAgentComponent) may
  // create the org's sentinel compute target and therefore needs the tx.
  // FEA-4011 Slice A: collect the component search projection inside the tx and
  // flush it fail-open after commit.
  const pendingSearchIndex: SearchProjectionInput[] = [];
  const result = await withDb.tx(async (tx) => {
    const created = await createCatalogItemInTx(tx, input, {
      pendingSearchIndex,
    });
    if (created.ok) {
      await recordWrite?.(tx, { changed: true });
    }
    return created;
  });

  if (!result.ok) {
    return result;
  }
  flushCatalogSearchIndex(pendingSearchIndex);
  const dto = await rowToDto(result.value);
  return Result.ok(dto);
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

/**
 * Update mutable fields on a CatalogItem.
 * Admins can update every mutable field on org-owned custom items. Non-admin
 * creators can update only item metadata and authored content for content
 * bearing target kinds. Read-only sources, archived rows, and foreign-org items
 * fail closed.
 */
export async function updateCatalogItem(
  input: UpdateCatalogInput,
  recordWrite?: RecordWriteInTransaction<OrganizationWriteOutcome>
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
        // Pack membership: a content edit on a MEMBER must re-link its new version
        // to the F1 registry (FEA-3909 F4), the same as the create/import paths.
        parentPackId: true,
      },
    })
  );

  if (!existing) {
    return Result.err(Status.NotFound);
  }
  // Two refusals wore one 403 and they answer different questions (ISS-8661).
  // An IMMUTABLE item refuses an org admin too, so no role lookup could have
  // changed the answer: it stays a decision even when nobody could read the
  // caller's role, and must never be re-answered as a retryable 503.
  if (isImmutableCatalogItemUpdate(existing, input)) {
    return Result.err(Status.Forbidden);
  }
  // Authorization-dependent: an admin WOULD have been allowed here, so a
  // refusal reached while the role was unresolved is "we could not decide".
  if (!canUpdateCatalogItem(existing, input)) {
    return Result.err(updateRefusalStatus(input));
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
      // A lost race against a concurrent writer, not a fresh verdict: the
      // predicate still narrows on `createdById` for a non-admin, so this
      // refusal is authorization-dependent and carries the same status.
      return Result.err<CatalogRow, UpdateCatalogError>(
        updateRefusalStatus(input)
      );
    }

    const row = await tx.catalogItem.findUnique({
      where: { id: input.id },
      select: CATALOG_ITEM_SELECT,
    });
    if (!row) {
      return Result.err<CatalogRow, UpdateCatalogError>(Status.NotFound);
    }

    // A new authored body appends a new version (monotonic max+1), so edits are
    // a versioned artifact history rather than an in-place overwrite.
    if (input.content !== undefined) {
      const last = await tx.catalogItemVersion.findFirst({
        where: { catalogItemId: input.id },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const editedVersion = await tx.catalogItemVersion.create({
        data: {
          catalogItemId: input.id,
          version: (last?.version ?? 0) + 1,
          name: row.name,
          content: input.content,
          changedById: input.userId,
        },
        select: { id: true },
      });
      // FEA-3909 (F4): an edit to a PACK MEMBER links the newly-appended version's
      // exact body to the F1 registry and records its `pack` occurrence — the same
      // seam the create + import paths write. Standalone (non-member) edits stay out
      // of F4 scope; empty bodies are left unlinked by the shared conservative guard.
      if (existing.parentPackId != null) {
        await linkPackMemberDefinition(tx, {
          organizationId: input.organizationId,
          packId: existing.parentPackId,
          catalogItemVersionId: editedVersion.id,
          targetKind: existing.targetKind,
          content: input.content,
        });
      }
    }

    await recordWrite?.(tx, { changed: true });
    return Result.ok<CatalogRow, UpdateCatalogError>(row);
  });

  if (!updatedResult.ok) {
    return updatedResult;
  }

  const dto = await rowToDto(updatedResult.value);
  return Result.ok(dto);
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
  input: ArchiveCatalogInput,
  recordWrite?: RecordWriteInTransaction<OrganizationWriteOutcome>
): Promise<Result<{ archived: true }, ArchiveCatalogError>> {
  const existing = await withDb((db) =>
    db.catalogItem.findFirst({
      where: { id: input.id, organizationId: input.organizationId },
      select: { id: true, source: true, archived: true },
    })
  );

  if (!existing) {
    return Result.err(404);
  }
  if (existing.source === "curated") {
    return Result.err(403);
  }

  // ISS-12552: archiving an archived item moves nothing, so it is a no-op.
  await writeRecorded(
    recordWrite,
    () =>
      withDb((db) =>
        db.catalogItem.update({
          where: { id: input.id },
          data: { archived: true },
          select: { id: true },
        })
      ),
    () => ({ changed: !existing.archived })
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

// The pack-import transaction takes a per-pack advisory lock as its first
// statement (see createPackComponents), so a concurrent second import of the
// same pack *blocks inside its own transaction* until the first import commits.
// That wait is added to this transaction's own dedupe read + batched child
// writes, so the total time a blocked import spends open can far exceed Prisma's
// 5s default interactive-transaction timeout — a blocked import would then abort
// with a transaction timeout instead of gracefully waiting, re-reading the
// committed children, and deduping. Raise both bounds to give the lock wait
// ample room, matching the long-running-writer convention used elsewhere in
// apps/api (e.g. the GitHub backfill projection writer): 30s work timeout, 5s
// max wait to acquire a pool connection (FEA-3251).
const PACK_IMPORT_TRANSACTION_TIMEOUT_MS = 30_000;
const PACK_IMPORT_TRANSACTION_MAX_WAIT_MS = 5000;

/** 404 not found · 403 curated · 400 no zip uploaded · 413 zip over size/entry budget. */
type ImportPackZipError = 404 | 403 | 400 | 413;

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
 * Atomicity & concurrency: the existing-children read and every child create
 * run inside one `withDb.tx`, guarded by a per-pack transaction-scoped advisory
 * lock taken first. The lock serializes concurrent imports of the same pack, so
 * a retried POST or a concurrent second import waits for the first to commit,
 * then re-reads the committed children and skips what it already wrote. Without
 * the lock the shared READ COMMITTED transaction would let two simultaneous
 * imports each read the same pre-image and both insert the full set — duplicate
 * children, since only agent kinds have a DB unique guard (FEA-3251). Children
 * are inserted in batched `createMany` calls (items, then their first versions,
 * then the agent `agent_components` materialization) rather than one item at a
 * time, so a large pack no longer holds the write transaction open across
 * hundreds of serial round-trips. Every child is still versioned from creation
 * and — for agents — materialized in `agent_components`.
 */
async function createPackComponents(
  input: { id: string; organizationId: string; userId: string },
  components: ReadonlyArray<{ kind: string; name: string; content: string }>,
  recordWrite?: RecordWriteInTransaction<OrganizationWriteOutcome>
): Promise<ImportPackZipResponse> {
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

  // FEA-4011 Slice A: collected inside the import tx, flushed fail-open after it
  // commits so a projection failure can never roll back the pack import.
  const pendingSearchIndex: SearchProjectionInput[] = [];
  const { created, skipped } = await withDb.tx(
    async (tx) => {
      // Serialize concurrent imports of the SAME pack before the dedupe
      // read+write. There is no DB unique constraint on
      // (parentPackId, targetKind, lower(name)) for non-agent kinds, and the
      // transaction runs at Postgres' default READ COMMITTED isolation, so two
      // imports of one pack running at once (an admin double-click, or a retried
      // import-repo request) each read the same pre-image and neither sees the
      // other's uncommitted child inserts — both then insert the full set,
      // creating duplicate skill/command/hook/mcp children (FEA-3251). A
      // per-pack, transaction-scoped advisory lock makes the second import block
      // until the first commits, then re-read the now-committed children and skip
      // them (keeping the re-run idempotent) — without a schema change or forcing
      // Serializable isolation on the whole transaction. Auto-released on
      // commit/rollback; keyed per pack so imports of different packs never
      // contend.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`catalog:pack-import:${input.id}`}))`;

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

      // Build every child row client-side — pre-deriving the uuidv7 id (matching
      // the schema's @default(uuid(7))) so the version and agent_components rows
      // can reference it without a per-row read-back — then persist them in a
      // handful of batched writes (`createMany`) instead of the ~3-4 serial
      // round-trips per component the old per-item loop made. The whole thing
      // still runs inside the one write transaction and rebuilds the dedupe set
      // from the in-tx children read, so atomicity and idempotency are unchanged;
      // there are just far fewer round-trips holding the transaction open.
      //
      // The pack was already validated by the caller (org-owned,
      // targetKind==="pack"), which is why `createCatalogItemInTx` was previously
      // called with skipParentValidation; inlining the inserts here preserves
      // that (no per-child parent lookup). Passing a request-derived parentPackId
      // without that upfront check would be unsafe (cross-org child leak).
      const itemRows: Prisma.CatalogItemCreateManyInput[] = [];
      const versionRows: Prisma.CatalogItemVersionCreateManyInput[] = [];
      const agentComponents: {
        catalogItemId: string;
        name: string;
        description: string | null;
      }[] = [];
      // FEA-3909 (F4): members whose exact body must be linked to the F1 registry
      // + get a `pack` occurrence, after their version rows are batch-created.
      const packMembers: {
        catalogItemVersionId: string;
        targetKind: string;
        content: string;
      }[] = [];
      let skippedCount = 0;

      for (const component of validComponents) {
        const key = `${component.kind}:${component.name.toLowerCase()}`;
        if (existingKeys.has(key)) {
          skippedCount++;
          continue;
        }
        existingKeys.add(key);

        const id = uuidv7();
        itemRows.push({
          id,
          organizationId: input.organizationId,
          targetKind: component.kind,
          source: "org_custom",
          scope: "org",
          name: component.name,
          description: null,
          sortOrder: 0,
          coaching: false,
          parentPackId: input.id,
          // Content-addressed identity for the imported component (same
          // derivation createCatalogItemInTx uses).
          componentUuid: deriveComponentUuid({
            content: component.content,
            sourceRepo: undefined,
            organizationId: input.organizationId,
          }),
          createdById: input.userId,
        });
        // Persist the imported body as the item's first version (versioned from
        // creation), mirroring createCatalogItemInTx. Pre-derive the version id
        // so the F1 link can be stamped after the batched createMany without a
        // per-row read-back.
        const versionId = uuidv7();
        versionRows.push({
          id: versionId,
          catalogItemId: id,
          version: 1,
          name: component.name,
          content: component.content,
          changedById: input.userId,
        });
        packMembers.push({
          catalogItemVersionId: versionId,
          targetKind: component.kind,
          content: component.content,
        });
        // For agents, mirror createCatalogItemInTx's agent_components
        // materialization so the imported agent is visible in the Agents
        // workspace; batched below via the shared cloud sentinel.
        if (component.kind === "agent") {
          agentComponents.push({
            catalogItemId: id,
            name: component.name,
            description: null,
          });
        }
      }

      if (itemRows.length > 0) {
        await tx.catalogItem.createMany({ data: itemRows });
        await tx.catalogItemVersion.createMany({ data: versionRows });
        await materializeCloudAgentComponentsBatch(
          tx,
          {
            organizationId: input.organizationId,
            createdById: input.userId,
            components: agentComponents,
          },
          pendingSearchIndex
        );
        // FEA-3909 (F4): link each newly-created pack member's exact body to the
        // F1 registry and record its `pack` occurrence. Sequential on purpose —
        // this runs inside the pinned pack-import transaction (one connection),
        // where a fan-out would only serialize on that same connection while
        // risking the interactive-transaction timeout; import batches are the
        // pack's component count, well within budget.
        for (const member of packMembers) {
          await linkPackMemberDefinition(tx, {
            organizationId: input.organizationId,
            packId: input.id,
            catalogItemVersionId: member.catalogItemVersionId,
            targetKind: member.targetKind,
            content: member.content,
          });
        }
      }

      await recordWrite?.(tx, { changed: itemRows.length > 0 });
      return { created: itemRows.length, skipped: skippedCount };
    },
    {
      // A concurrent import blocks on the advisory lock inside this transaction
      // until the first import commits, so the wait must not trip Prisma's 5s
      // default interactive-transaction timeout (which would abort the blocked
      // import instead of letting it dedupe). See PACK_IMPORT_TRANSACTION_*.
      maxWait: PACK_IMPORT_TRANSACTION_MAX_WAIT_MS,
      timeout: PACK_IMPORT_TRANSACTION_TIMEOUT_MS,
    }
  );

  flushCatalogSearchIndex(pendingSearchIndex);
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
  input: ImportPackZipInput,
  recordWrite?: RecordWriteInTransaction<OrganizationWriteOutcome>
): Promise<Result<ImportPackZipResponse, ImportPackZipError>> {
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

  const result = await createPackComponents(input, components, recordWrite);
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
  input: ImportPackRepoInput,
  recordWrite?: RecordWriteInTransaction<OrganizationWriteOutcome>
): Promise<Result<ImportPackZipResponse, ImportPackRepoError>> {
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

  const result = await createPackComponents(input, components, recordWrite);
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

/**
 * Verify a previously-PUT catalog asset exists in S3 (HeadObject) and record
 * its key in the CatalogItem row. Returns the updated CatalogItemDto on success.
 */
export async function confirmAssetUpload(
  input: ConfirmUploadInput,
  recordWrite?: RecordWriteInTransaction<OrganizationWriteOutcome>
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
    return Result.err(CatalogAssetError.AssetNotFound);
  }

  const assetMeta = await headCatalogAsset(input.s3Key);
  if (!assetMeta) {
    return Result.err(CatalogAssetError.AssetNotFound);
  }

  // Persist the resolved PLUGIN_STORE_BUCKET alongside the key so download-URL
  // builders (e.g. distributionsService.buildAssetDownloadUrl) can resolve the
  // correct bucket instead of falling back to FILE_ATTACHMENTS_BUCKET.
  const assetBucket = resolveCatalogBucket();
  const updateData =
    input.fileType === "zip"
      ? { zipAssetBucket: assetBucket, zipAssetKey: input.s3Key }
      : { logoAssetBucket: assetBucket, logoAssetKey: input.s3Key };

  const updated = await writeRecorded(
    recordWrite,
    () =>
      withDb((db) =>
        db.catalogItem.update({
          where: { id: input.catalogItemId },
          data: updateData,
          select: CATALOG_ITEM_SELECT,
        })
      ),
    () => ({ changed: true })
  );

  const dto = await rowToDto(updated);
  return Result.ok(dto);
}
