/**
 * Distribution platform shared DTOs (FEA-2923 batch 3).
 *
 * Canonical shared types for the CatalogItem / Distribution / DistributionTargetStatus
 * sub-system, consumed by BOTH the web surface (`apps/app`) and the desktop renderer
 * via `apps/api` routes. All enums follow the repo-sanctioned `{…} as const` +
 * `(typeof X)[keyof typeof X]` idiom — never TypeScript `enum`. Pattern mirrors
 * `packages/api/src/types/branch.ts`.
 *
 * @repo/api MUST NOT import from @repo/app or apps/*.
 */

// ---------------------------------------------------------------------------
// CatalogItem enums
// ---------------------------------------------------------------------------

/**
 * Origin tier of a CatalogItem.
 * - `org_custom`  — uploaded by an org admin; private to the org.
 * - `curated`     — ClosedLoop-managed best-practice items; read-only to orgs.
 * - `marketplace` — future public cross-harness marketplace; reserved hook only.
 */
export const CatalogItemSource = {
  OrgCustom: "org_custom",
  Curated: "curated",
  Marketplace: "marketplace",
} as const;
export type CatalogItemSource =
  (typeof CatalogItemSource)[keyof typeof CatalogItemSource];

/**
 * Visibility scope of a CatalogItem.
 * - `org`    — visible only within the owning org (all org_custom items).
 * - `global` — visible to all orgs (curated items).
 */
export const CatalogItemScope = {
  Org: "org",
  Global: "global",
} as const;
export type CatalogItemScope =
  (typeof CatalogItemScope)[keyof typeof CatalogItemScope];

// ---------------------------------------------------------------------------
// Distribution enums
// ---------------------------------------------------------------------------

/**
 * How a distribution is delivered to targeted devices.
 * - `auto_install` — installs (and enables) without user action on next desktop open.
 * - `opt_in`       — surfaced to the user; requires explicit acceptance.
 */
export const DistributionMode = {
  AutoInstall: "auto_install",
  OptIn: "opt_in",
} as const;
export type DistributionMode =
  (typeof DistributionMode)[keyof typeof DistributionMode];

/**
 * Whether a distribution targets all compute targets in the org or a specific subset.
 */
export const DistributionTargetingType = {
  All: "all",
  Specific: "specific",
} as const;
export type DistributionTargetingType =
  (typeof DistributionTargetingType)[keyof typeof DistributionTargetingType];

// ---------------------------------------------------------------------------
// DistributionTargetStatus enums
// ---------------------------------------------------------------------------

/**
 * Per-device install/enable lifecycle status for a distribution assignment.
 * Values match the `status` column in the `distribution_target_status` table.
 */
export const DistributionTargetStatusValue = {
  Pending: "pending",
  Installed: "installed",
  Enabled: "enabled",
  Failed: "failed",
  OptedIn: "opted_in",
  Declined: "declined",
} as const;
export type DistributionTargetStatusValue =
  (typeof DistributionTargetStatusValue)[keyof typeof DistributionTargetStatusValue];

// ---------------------------------------------------------------------------
// CatalogItem DTOs
// ---------------------------------------------------------------------------

/**
 * API representation of a CatalogItem (list + detail response shape).
 */
export type CatalogItemDto = {
  id: string;
  organizationId: string | null;
  targetKind: string; // plugin|skill|command|agent|hook|mcp
  source: CatalogItemSource;
  scope: CatalogItemScope;
  name: string;
  description: string | null;
  version: string;
  sortOrder: number;
  enabled: boolean;
  archived: boolean;
  coaching: boolean;
  coachingConfig: Record<string, unknown> | null;
  /**
   * Parent Pack id for a component authored inside a Pack; null for a top-level
   * Pack or a standalone item. A Pack is a top-level CatalogItem that holds N
   * child component items (skill/command/agent/hook/plugin/mcp).
   */
  parentPackId: string | null;
  /**
   * Content-addressed component identity (`computeComponentUuid`): stable across
   * author/import origin — the dedup + cloud-analytics join key. Null for
   * asset-only items and the Pack container. Optional on the DTO so the field
   * degrades safely under version skew (older API omitting it, older client
   * ignoring it) — treat an absent value the same as null.
   */
  componentUuid?: string | null;
  /**
   * Latest authored `.md` / config body (frontmatter + prompt, or JSON for
   * config kinds) from the item's newest CatalogItemVersion. Populated on the
   * detail read only; null on list responses and for asset-only items.
   */
  content: string | null;
  /**
   * Child component items of a Pack. Populated on the detail read only; empty
   * on list responses and for non-Pack items.
   */
  components: CatalogItemDto[];
  /**
   * Org-level identity slug of the linked AgentComponent (`${kind}::${key}`),
   * when this catalog item was promoted from / maps to a discovered component.
   * Null for items with no analytics linkage. Consumers use it to fetch the
   * canonical per-pack usage/KLOC analytics from `/agent-components/{slug}`.
   */
  agentSlug: string | null;
  /** Presigned download URL for the logo asset (null when no logo uploaded). */
  logoUrl: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Request body for `POST /catalog` (admin-only, creates a CatalogItem).
 */
export type CreateCatalogItemRequest = {
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
};

/**
 * Response for the Pack import endpoints (`POST /catalog/{id}/import-zip` and
 * `POST /catalog/{id}/import-repo`) — how many child components were created vs
 * skipped (already present).
 */
export type ImportPackZipResponse = {
  created: number;
  skipped: number;
};

/**
 * Request body for `POST /catalog/{id}/import-repo` — import components from a
 * GitHub repo the org has App visibility to (canonical Claude Code layout).
 */
export type ImportPackRepoRequest = {
  /** `owner/name` of a repo in the org's GitHub App installation. */
  repoFullName: string;
  /** Git ref (branch/tag/sha); defaults to the repo's default branch. */
  ref?: string;
  /** Only import under this subdirectory (e.g. `.claude`). */
  subPath?: string;
};

/**
 * Request body for `PATCH /catalog/{id}`. Admins can update every mutable field
 * on editable org-custom items; item creators can update only allowed metadata
 * and supported authored content.
 */
export type UpdateCatalogItemRequest = {
  name?: string;
  description?: string;
  sortOrder?: number;
  enabled?: boolean;
  coaching?: boolean;
  coachingConfig?: Record<string, unknown>;
  /** New authored `.md` / config body; persisted as a new version when present. */
  content?: string;
};

// ---------------------------------------------------------------------------
// Distribution DTOs
// ---------------------------------------------------------------------------

/**
 * A single targeting entry for a specific-targeting Distribution.
 */
export type DistributionTargetingEntry = {
  computeTargetId: string | null;
  userId: string | null;
};

/**
 * Per-device status row exposed on the distribution detail response.
 */
export type DistributionTargetStatusDto = {
  id: string;
  distributionId: string;
  computeTargetId: string | null;
  userId: string | null;
  status: DistributionTargetStatusValue;
  installedVersion: string | null;
  installRunId: string | null;
  overriddenLocally: boolean;
  failureReason: string | null;
  installedAt: string | null;
  enabledAt: string | null;
  reportedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * API representation of a Distribution (list + detail response shape).
 * `targetStatuses` is populated only on the detail view.
 */
export type DistributionDto = {
  id: string;
  organizationId: string;
  catalogItemId: string;
  catalogItem: Pick<CatalogItemDto, "id" | "name" | "targetKind" | "source"> & {
    /**
     * Whether the underlying CatalogItem is a coaching pack (FEA-2923 batch 5).
     * When true, the desktop installer routes the distribution through the
     * coaching-pack install/activate path (`installCoachingPackFromDistribution`)
     * rather than the generic `pack_catalog` streamRun install. Optional +
     * defaults to false for wire back-compat with responses that omit it.
     */
    coaching?: boolean;
  };
  mode: DistributionMode;
  targetingType: DistributionTargetingType;
  desiredEnabled: boolean;
  targetingEntries: DistributionTargetingEntry[];
  /** Populated on detail (GET /distributions/{id}) only; empty on list. */
  targetStatuses: DistributionTargetStatusDto[];
  /**
   * Presigned S3 download URL for the zip asset (15-minute TTL).
   * Non-null only on the desktop-assigned-distributions response when the
   * CatalogItem has a zip asset uploaded and the distribution mode is
   * `auto_install`.
   */
  assetDownloadUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Renderer-facing projection of a {@link DistributionDto} for the desktop
 * opt-in banner push (`desktop:distributions:opt-in-available`, FEA-2923 / §I;
 * FEA-3043).
 *
 * The banner installs by `id` (`coachingInstall(dist.id)`) and the main process
 * re-resolves the asset from the authoritative cloud response by id — never
 * trusting renderer-supplied asset data. So the renderer needs only the fields
 * it renders/branches on and must NOT receive the live 15-minute presigned
 * `assetDownloadUrl`, which is a main-only capability URL. This is that minimal
 * projection; build it with {@link toOptInDistributionDto} before
 * `webContents.send`.
 */
export type OptInDistributionDto = Pick<DistributionDto, "id" | "mode"> & {
  catalogItem: Pick<CatalogItemDto, "id" | "name" | "targetKind"> & {
    coaching?: boolean;
  };
};

/**
 * Project a full {@link DistributionDto} down to the renderer-safe
 * {@link OptInDistributionDto}, dropping the presigned `assetDownloadUrl` and
 * every other main-only field before it crosses the IPC boundary (FEA-3043).
 */
export function toOptInDistributionDto(
  distribution: DistributionDto
): OptInDistributionDto {
  return {
    id: distribution.id,
    mode: distribution.mode,
    catalogItem: {
      id: distribution.catalogItem.id,
      name: distribution.catalogItem.name,
      targetKind: distribution.catalogItem.targetKind,
      coaching: distribution.catalogItem.coaching,
    },
  };
}

/**
 * Request body for `POST /distributions` (admin-only, creates a Distribution).
 */
export type CreateDistributionRequest = {
  catalogItemId: string;
  mode: DistributionMode;
  targetingType: DistributionTargetingType;
  desiredEnabled?: boolean;
  /** Required when `targetingType` is `specific`. */
  targetComputeTargetIds?: string[];
  /** Required when `targetingType` is `specific`. */
  targetUserIds?: string[];
};

/**
 * Request body for `PATCH /distributions/{id}` (admin-only, partial update).
 */
export type UpdateDistributionRequest = {
  mode?: DistributionMode;
  targetingType?: DistributionTargetingType;
  desiredEnabled?: boolean;
  targetComputeTargetIds?: string[];
  targetUserIds?: string[];
};

// ---------------------------------------------------------------------------
// Promote (best-of-breed) DTOs
// ---------------------------------------------------------------------------

/**
 * Minimal identity of a discovered AgentComponent that can be promoted to a
 * CatalogItem + Distribution.  Used by the promote flow in `packages/app` and
 * the admin-catalog E2E spec.  Intentionally decoupled from the analytics
 * `RankingItem` type (PR3) so that the distribution platform (PR2) can stand
 * alone without a cross-PR dependency.
 */
export type PromoteCandidate = {
  /** Cloud UUID of the AgentComponent row.  Optional — absent for unsynced items. */
  agentComponentId?: string;
  /** Component kind (plugin, skill, command, …). */
  kind: string;
  /** Stable slug / key identifying the component. */
  key: string;
  /** Human-readable display name. */
  name: string;
};

/**
 * Request body for `POST /agent-components/promote` (admin-only).
 * Promotes a discovered AgentComponent to a CatalogItem + all-targeting Distribution.
 */
export type PromoteRequest = {
  agentComponentId: string;
  name?: string;
  description?: string;
  targetKind?: string;
  sortOrder?: number;
};

/**
 * Response for `POST /agent-components/promote`.
 */
export type PromoteResponse = {
  catalogItemId: string;
  distributionId: string;
};

// ---------------------------------------------------------------------------
// Desktop distribution assignment DTOs
// ---------------------------------------------------------------------------

/**
 * A single status report from the desktop for `POST /desktop/distributions/status`.
 */
export type DistributionStatusReport = {
  distributionId: string;
  status: DistributionTargetStatusValue;
  installedVersion?: string;
  installRunId?: string;
  failureReason?: string;
};

/**
 * Response for `POST /desktop/distributions/status`.
 */
export type DesktopDistributionStatusResponse = {
  accepted: number;
};
