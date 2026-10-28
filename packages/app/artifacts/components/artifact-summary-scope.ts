import type { CustomFieldWithOptions } from "@repo/api/src/types/custom-field";
import {
  DOCUMENT_LIST_MAX_SEARCH_LENGTH,
  DocumentStatus,
  type FindDocumentsOptions,
  IssueStatus,
  normalizeDocumentType,
} from "@repo/api/src/types/document";
import { documentCostScopeSchema } from "@repo/api/src/types/document-costs";
import {
  type DocumentSummaryParams,
  documentMetricScopeIdsSchema,
} from "@repo/api/src/types/document-metric-scope";
import {
  genericArtifactStatusFromRaw,
  genericArtifactStatusMatchesAny,
} from "@repo/app/shared/components/generic-artifact-surface/generic-artifact-status";
import { updatedPresetMinutes } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-model";
import type { ArtifactListShellController } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-shell-content";
import {
  ArtifactKind,
  ArtifactStatus,
} from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { UNASSIGNED_ASSIGNEE_LABEL } from "@repo/app/shared/lib/user-utils";
import { artifactExtensionFilterScope } from "./artifact-summary-extension-scope";

export function artifactSummaryScope(
  controller: Pick<
    ArtifactListShellController,
    | "filters"
    | "dateDimension"
    | "customFieldFilters"
    | "extensionFilters"
    | "extensionColumns"
  >,
  currentUserId: string,
  filterText: string,
  searchParams: FindDocumentsOptions,
  artifactKind:
    | typeof ArtifactKind.Document
    | typeof ArtifactKind.Issue = ArtifactKind.Document,
  completeArtifactIds?: readonly string[],
  customFields: readonly CustomFieldWithOptions[] = []
): ArtifactSummaryScope {
  const params: DocumentSummaryParams = { ...searchParams };
  if (filterText.trim()) {
    params.search = filterText.trim();
  }
  const filters = controller.filters;
  const days = artifactRecencyDays(controller);
  if (days !== undefined) {
    params.recencyDays = days;
  }
  if (filters.mineOnly && currentUserId) {
    params.assigneeId = currentUserId;
  }
  Object.assign(params, ownerScope(filters.owners, filters.mineOnly));
  if (filters.tags.length > 0) {
    params.tagIds = [...new Set(filters.tags)].sort();
  }
  if (filters.favoritesOnly) {
    params.favoritesOnly = true;
  }
  if (filters.statuses.length > 0) {
    params.status = Object.values(
      artifactKind === ArtifactKind.Issue ? IssueStatus : DocumentStatus
    ).filter((status) =>
      genericArtifactStatusMatchesAny(
        {
          kind: artifactKind,
          status:
            genericArtifactStatusFromRaw(artifactKind, status) ??
            ArtifactStatus.Draft,
          statusRaw: status,
        },
        filters.statuses
      )
    );
  }
  const extension = artifactExtensionFilterScope(
    controller.extensionFilters,
    controller.extensionColumns,
    customFields
  );
  if (extension.customFieldFilters.length > 0) {
    params.customFieldFilters = extension.customFieldFilters;
  }
  if (extension.types) {
    const selected = extension.types;
    params.types = (params.types ?? selected).filter((type) =>
      selected.includes(normalizeDocumentType(type))
    );
  }
  const canSummarize =
    (filters.kinds.length === 0 || filters.kinds.includes(artifactKind)) &&
    filterText.trim().length <= DOCUMENT_LIST_MAX_SEARCH_LENGTH &&
    !(filters.mineOnly && !currentUserId) &&
    (params.status === undefined || params.status.length > 0) &&
    (params.types === undefined || params.types.length > 0) &&
    isScopeIdSet(params.assigneeIds) &&
    isScopeIdSet(params.tagIds) &&
    extension.expressible &&
    Object.values(controller.customFieldFilters).every(
      (filter) =>
        !filter.selectedValues?.length &&
        filter.min === undefined &&
        filter.max === undefined
    );
  // ISS-12600: only a filter with no server predicate (see
  // `artifactExtensionFilterScope`) still reads the complete matching ids.
  if (!canSummarize && completeArtifactIds !== undefined) {
    return cohortSummaryScope(searchParams, completeArtifactIds);
  }
  return { params, canSummarize };
}

export function artifactRecencyDays(
  controller: Pick<ArtifactListShellController, "filters" | "dateDimension">
): number | undefined {
  const range = controller.dateDimension.present
    ? controller.dateDimension.range
    : "all";
  const rangeDays = range === "all" ? undefined : Number(range.slice(0, -1));
  const minutes = updatedPresetMinutes(controller.filters.updatedPreset);
  const presetDays = minutes === null ? undefined : minutes / (24 * 60);
  if (rangeDays !== undefined && presetDays !== undefined) {
    return Math.min(rangeDays, presetDays);
  }
  return rangeDays ?? presetDays;
}

export function artifactCostScope(scope: ArtifactSummaryScope) {
  if (!scope.canSummarize || scope.params.artifactIds !== undefined) {
    return undefined;
  }
  return documentCostScopeSchema.parse({
    types: scope.params.types,
    search: scope.params.search,
    assigneeId: scope.params.assigneeId,
    status: scope.params.status,
    recencyDays: scope.params.recencyDays,
    assigneeIds: scope.params.assigneeIds,
    includeUnassigned: scope.params.includeUnassigned,
    tagIds: scope.params.tagIds,
    favoritesOnly: scope.params.favoritesOnly,
    customFieldFilters: scope.params.customFieldFilters,
  });
}

/**
 * The owner facet as a server scope. A lone owner keeps the scalar `assigneeId`
 * every server already honors; a union, the Unassigned facet, or an owner beside
 * "mine" (the list intersects the two) travels as `assigneeIds` and
 * `includeUnassigned`.
 */
function ownerScope(
  owners: readonly string[],
  mineOnly: boolean
): Pick<
  DocumentSummaryParams,
  "assigneeId" | "assigneeIds" | "includeUnassigned"
> {
  const ids = [
    ...new Set(owners.filter((owner) => owner !== UNASSIGNED_ASSIGNEE_LABEL)),
  ].sort();
  const includeUnassigned = owners.includes(UNASSIGNED_ASSIGNEE_LABEL);
  if (!(mineOnly || includeUnassigned) && ids.length === 1) {
    return { assigneeId: ids[0] };
  }
  return {
    ...(ids.length > 0 ? { assigneeIds: ids } : {}),
    ...(includeUnassigned ? { includeUnassigned: true } : {}),
  };
}

/** An id facet the metric endpoints accept: absent, or a bounded uuid set. */
function isScopeIdSet(ids: readonly string[] | undefined): boolean {
  return (
    ids === undefined || documentMetricScopeIdsSchema.safeParse(ids).success
  );
}

/** The summary and cost reads' parameters, and whether they may be issued. */
export type ArtifactSummaryScope = {
  params: DocumentSummaryParams;
  canSummarize: boolean;
};

/**
 * The complete matching ids as the scope (the origin/main cohort read): used
 * for a filter with no server predicate, and when the server refuses a scope.
 */
export function cohortSummaryScope(
  searchParams: FindDocumentsOptions,
  completeArtifactIds: readonly string[]
): ArtifactSummaryScope {
  return {
    params: {
      ...searchParams,
      artifactIds: [...new Set(completeArtifactIds)].sort(),
    },
    canSummarize: true,
  };
}
