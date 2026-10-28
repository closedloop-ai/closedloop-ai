"use client";

import type { Artifact } from "@repo/api/src/types/artifact";
import {
  ArtifactSubtype,
  ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact";
import { MANUAL_ARTIFACT_ORDERING_FLAG_KEY } from "@repo/api/src/types/manual-artifact-ordering-flag";
import type { ProjectArtifactPlacementResponse } from "@repo/api/src/types/project-artifact-placement";
import {
  ProjectArtifactPlacementKind,
  projectArtifactPlacementValidator,
} from "@repo/api/src/types/project-artifact-placement";
import { applyPlacementToProjectTree } from "@repo/api/src/types/project-artifact-placement-tree";
import type {
  ProjectTreeResponse,
  TreeChild,
  TreeNode,
} from "@repo/api/src/types/project-tree";
import type { BasicUser } from "@repo/api/src/types/user";
import type { NavigationAdapter } from "@repo/navigation/navigation-adapter";
import { useEffect, useMemo, useRef, useState } from "react";
import { projectTreeKeys } from "../../../projects/hooks/project-tree-keys";
import { projectArtifactPlacementCapabilityKey } from "../../../projects/hooks/use-artifact-placement";
import type { ProjectSummaryRow } from "../../../projects/lib/project-summary-row";
import { genericArtifactStatusRaw } from "../../../shared/components/generic-artifact-surface/generic-artifact-status";
import type { GenericArtifact } from "../../../shared/components/generic-artifact-surface/preview/fixtures";
import { ArtifactKind } from "../../../shared/components/generic-artifact-surface/preview/fixtures";
import { DocumentColumn } from "../../../shared/hooks/use-column-visibility";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { FixtureRoute } from "../../../shared/storybook/fixture-fetch";
import { documentRowFromArtifact } from "../../lib/artifact-row-adapter";
import { GroupByMode } from "../../lib/group-by";
import { DocumentsView } from "./documents-view";

type DocumentsViewPrototypePreviewProps = {
  artifacts: readonly GenericArtifact[];
  navigationAdapter: NavigationAdapter;
  project: ProjectSummaryRow;
};

const PROTOTYPE_PROJECT_ID = "00000000-0000-4000-8000-000000000725";

/** Prop-driven mock adapter for rendering the production Documents View in prototypes. */
export function DocumentsViewPrototypePreview({
  artifacts,
  navigationAdapter,
  project,
}: DocumentsViewPrototypePreviewProps) {
  const initial = useMemo(
    () => buildProjectDocumentsFixture(project, artifacts),
    [artifacts, project]
  );
  const placementProjectId = initial.projectId;
  const [tree, setTree] = useState(initial.tree);
  const treeRef = useRef(tree);
  useEffect(() => {
    treeRef.current = initial.tree;
    setTree(initial.tree);
  }, [initial.tree]);
  const apiRoutes = useMemo<FixtureRoute[]>(
    () => [
      {
        method: "GET",
        path: `/projects/${placementProjectId}/tree`,
        respond: () => treeRef.current,
      },
      {
        method: "GET",
        path: `/projects/${placementProjectId}/artifacts/placement`,
        respond: () => ({
          projectId: placementProjectId,
          projectVersion: treeRef.current.projectVersion,
          canPlaceArtifacts: true,
        }),
      },
      { method: "GET", path: "/tags", respond: () => [] },
      {
        method: "POST",
        path: `/projects/${placementProjectId}/artifacts/placement`,
        respond: ({ body }) => {
          const request = projectArtifactPlacementValidator.parse(body);
          if (request.kind !== ProjectArtifactPlacementKind.Place) {
            return { placed: false };
          }
          const nextTree = {
            ...applyPlacementToProjectTree(
              treeRef.current,
              request,
              placementProjectId
            ),
            projectVersion: "prototype-version-2",
          };
          treeRef.current = nextTree;
          setTree(nextTree);
          return {
            placed: true,
            transactionId: "00000000-0000-4000-8000-000000000725",
            affectedArtifactIds: request.sourceArtifactIds,
            affectedProjectIds: [placementProjectId],
            projectVersions: { [placementProjectId]: nextTree.projectVersion },
            placement: request,
            replayed: false,
            undoAvailable: false,
          } satisfies ProjectArtifactPlacementResponse;
        },
      },
    ],
    [placementProjectId]
  );

  return (
    <AppCoreStoryProviders
      apiRoutes={apiRoutes}
      enabledFlags={[MANUAL_ARTIFACT_ORDERING_FLAG_KEY]}
      navigationAdapter={navigationAdapter}
      queryData={[
        [projectTreeKeys.detail(placementProjectId), initial.tree],
        [
          projectArtifactPlacementCapabilityKey(placementProjectId),
          {
            projectId: placementProjectId,
            projectVersion: initial.tree.projectVersion,
            canPlaceArtifacts: true,
          },
        ],
      ]}
    >
      <DocumentsView
        documents={initial.documents}
        filterCategory="all"
        filterText=""
        groupBy={GroupByMode.None}
        projectId={placementProjectId}
        sortPersistenceKey={null}
        storageKey={`prototype:project-artifacts:${project.id}`}
        treeData={tree}
        visibleColumns={[DocumentColumn.Assignee, DocumentColumn.Priority]}
      />
    </AppCoreStoryProviders>
  );
}

function buildProjectDocumentsFixture(
  project: ProjectSummaryRow,
  source: readonly GenericArtifact[]
) {
  const projectId = PROTOTYPE_PROJECT_ID;
  const artifactIds = new Map(
    source.map((artifact, index) => [artifact.id, prototypeArtifactId(index)])
  );
  const artifacts = source.map((artifact, index) =>
    toProjectTreeArtifact(artifact, artifactIds, projectId, index)
  );
  const artifactsById = new Map(
    artifacts.map((artifact) => [artifact.id, artifact])
  );
  const nodes: TreeNode[] = source.flatMap((artifact) => {
    if (artifact.parentArtifactId) {
      return [];
    }
    const root = artifactsById.get(artifactIds.get(artifact.id) ?? "");
    return root
      ? [
          {
            root,
            children: flattenChildren(
              artifact.id,
              source,
              artifactIds,
              artifactsById,
              1
            ),
          },
        ]
      : [];
  });
  const tree: ProjectTreeResponse = {
    nodes,
    externalParents: [],
    projectVersion: "prototype-version-1",
  };
  const projectContext = { id: projectId, name: project.name };
  const documents = artifacts.flatMap((artifact) => {
    const row = documentRowFromArtifact(artifact, projectContext);
    return row ? [row] : [];
  });
  return { documents, projectId, tree };
}

function flattenChildren(
  parentId: string,
  source: readonly GenericArtifact[],
  artifactIds: ReadonlyMap<string, string>,
  artifactsById: ReadonlyMap<string, Artifact>,
  depth: number
): TreeChild[] {
  return source
    .filter((artifact) => artifact.parentArtifactId === parentId)
    .flatMap((artifact) => {
      const artifactId = artifactIds.get(artifact.id);
      const raw = artifactId ? artifactsById.get(artifactId) : undefined;
      if (!raw) {
        return [];
      }
      const child: TreeChild = {
        ...raw,
        parentId: artifactIds.get(parentId) ?? parentId,
        depth,
        linkType: LinkType.Produces,
      };
      return [
        child,
        ...flattenChildren(
          artifact.id,
          source,
          artifactIds,
          artifactsById,
          depth + 1
        ),
      ];
    });
}

function toProjectTreeArtifact(
  artifact: GenericArtifact,
  artifactIds: ReadonlyMap<string, string>,
  projectId: string,
  index: number
): Artifact {
  const { type, subtype } = artifactShape(artifact.kind);
  const createdAt = new Date(
    Date.UTC(2026, 7, 14) - artifact.createdAgoDays * 86_400_000
  );
  const updatedAt = new Date(
    Date.UTC(2026, 7, 14) - artifact.updatedAgoMinutes * 60_000
  );
  return {
    id: artifactIds.get(artifact.id) ?? prototypeArtifactId(index),
    organizationId: "00000000-0000-4000-8000-000000000001",
    projectId,
    type,
    subtype,
    name: artifact.title,
    slug: artifact.slug,
    externalUrl: null,
    status: genericArtifactStatusRaw(artifact) ?? artifact.status,
    priority: null,
    assigneeId: assigneeOf(artifact)?.id ?? null,
    assignee: assigneeOf(artifact),
    dueDate: null,
    sortOrder: index * 1024,
    createdById: null,
    createdAt,
    updatedAt,
  };
}

function prototypeArtifactId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

function artifactShape(kind: GenericArtifact["kind"]): {
  type: ArtifactType;
  subtype: ArtifactSubtype | null;
} {
  if (kind === ArtifactKind.Branch) {
    return { type: ArtifactType.Branch, subtype: null };
  }
  if (kind === ArtifactKind.Session) {
    return { type: ArtifactType.Session, subtype: null };
  }
  return {
    type: ArtifactType.Document,
    subtype:
      kind === ArtifactKind.Issue || kind === ArtifactKind.Agent
        ? ArtifactSubtype.Feature
        : ArtifactSubtype.Doc,
  };
}

const WHITESPACE = /\s+/;

/** The fixture's owner as the assignee the project list renders. */
function assigneeOf(artifact: GenericArtifact): BasicUser | null {
  const [firstName, ...rest] = artifact.owner.trim().split(WHITESPACE);
  if (!firstName) {
    return null;
  }
  return {
    id: artifact.ownerId ?? `prototype-owner-${artifact.ownerInitials}`,
    email: "",
    firstName,
    lastName: rest.length > 0 ? rest.join(" ") : null,
    avatarUrl: null,
  };
}
