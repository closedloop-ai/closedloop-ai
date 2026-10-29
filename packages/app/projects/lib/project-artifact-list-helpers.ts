import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import type {
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import { PROJECT_TREE_MAX_VISIBLE_LEVELS } from "@repo/api/src/types/project-tree";
import type { useRelatedSessionsSearch } from "../../documents/hooks/use-related-sessions";
import type { useProjectArtifactListMetadata } from "../hooks/use-project-artifact-list-metadata";
import type { ProjectArtifactReadModel } from "./project-artifact-read-model";

export const PROJECT_COLUMNS = [
  "owner",
  "collaborators",
  "status",
  "relatedSessions",
  "comments",
  "updated",
  "currentVersion",
  "tags",
] as const;

export const PROJECT_HIERARCHY = {
  maxVisibleLevels: PROJECT_TREE_MAX_VISIBLE_LEVELS,
} as const;

/** Canonical input for placement writes from the project artifact list. */
export type ProjectArtifactMove = {
  artifactIds: string[];
  targetProjectId?: string;
  placement: ProjectArtifactPlacementPosition | "start" | "end";
  targetArtifactId?: string;
  source: Exclude<
    ProjectArtifactPlacementSource,
    typeof ProjectArtifactPlacementSource.Undo
  >;
};

export function projectArtifactParents(
  model: ProjectArtifactReadModel,
  id: string
) {
  const parentId = model.parentByArtifactId.get(id);
  const internal = parentId ? model.artifactsById.get(parentId) : undefined;
  const values = new Map(
    (model.parentContextByArtifactId.get(id) ?? []).map((link) => [
      link.parent.id,
      link.parent,
    ])
  );
  if (internal) {
    values.set(internal.id, internal);
  }
  return [...values.values()];
}
export function projectPeopleLoading(
  metadata: ReturnType<typeof useProjectArtifactListMetadata>,
  type: ArtifactType
) {
  switch (type) {
    case ArtifactType.Document:
      return metadata.peopleReads.documents.isLoading;
    case ArtifactType.Branch:
      return metadata.peopleReads.branches.isLoading;
    case ArtifactType.Session:
      return metadata.peopleReads.sessions.isLoading;
    case ArtifactType.Deployment:
      return metadata.peopleReads.deployments.isLoading;
    default: {
      const exhaustive: never = type;
      throw new Error(`Unsupported artifact type: ${exhaustive}`);
    }
  }
}

export function projectArtifactHref(
  type: ArtifactType | undefined,
  route: string | null | undefined,
  orgPath: (path: string) => string
): string | undefined {
  if (!route) {
    return undefined;
  }
  if (type === ArtifactType.Deployment) {
    return route;
  }
  return orgPath(route);
}

export function projectArtifactFilterState(input: {
  loading: boolean;
  failed: boolean;
  evidenceUnavailable: boolean;
  sessionFilterPending: boolean;
  sessionFilterFailed: boolean;
}) {
  return {
    unavailable:
      input.evidenceUnavailable ||
      input.sessionFilterPending ||
      input.sessionFilterFailed,
    summaryLoading: input.loading || input.sessionFilterPending,
    summaryFailed:
      input.failed || input.evidenceUnavailable || input.sessionFilterFailed,
  };
}

export function projectRelatedSessionFilterStatus(input: {
  selectedIds: readonly string[];
  appliedIds: readonly string[];
  isFetching: boolean;
  isError: boolean;
}) {
  const active = input.selectedIds.length > 0;
  return {
    pending:
      active &&
      (input.isFetching ||
        JSON.stringify(input.selectedIds) !== JSON.stringify(input.appliedIds)),
    failed: active && input.isError,
  };
}

export function statusGroupingActive(controller: {
  groupBy: string;
  secondaryGroupBy: string;
}): boolean {
  return (
    controller.groupBy === "status" || controller.secondaryGroupBy === "status"
  );
}

export function projectArtifactSessionOptions(
  relatedResults: NonNullable<
    ReturnType<typeof useProjectArtifactListMetadata>["relatedSessions"]["data"]
  >["results"],
  candidates: NonNullable<
    ReturnType<typeof useRelatedSessionsSearch>["data"]
  >["items"]
) {
  const values = new Map<string, string>();
  for (const result of Object.values(relatedResults)) {
    for (const session of result.items) {
      values.set(
        session.sessionArtifactId,
        session.name ?? session.slug ?? session.sessionArtifactId
      );
    }
  }
  for (const session of candidates) {
    values.set(
      session.sessionArtifactId,
      session.name ?? session.slug ?? session.sessionArtifactId
    );
  }
  return [...values].map(([id, label]) => ({ id, label }));
}

export function projectArtifactMatchesCategory(
  model: ProjectArtifactReadModel,
  id: string,
  category: "all" | "documents" | "issues" | "plans" | "branches"
) {
  const source = model.artifactsById.get(id);
  if (!source) {
    return false;
  }
  if (category === "all") {
    return true;
  }
  if (category === "branches") {
    return source.type === ArtifactType.Branch;
  }
  const subtype = {
    documents: ArtifactSubtype.Prd,
    issues: ArtifactSubtype.Feature,
    plans: ArtifactSubtype.ImplementationPlan,
  }[category];
  return source.type === ArtifactType.Document && source.subtype === subtype;
}
