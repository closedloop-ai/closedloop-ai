"use client";

import {
  type ArtifactLinkEndpoint,
  LinkDirection,
  LinkQueryMode,
  LinkType,
} from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import {
  type Document,
  DocumentStatus,
  DocumentType,
} from "@repo/api/src/types/document";
import { useMemo, useState } from "react";
import { ArtifactRow } from "@/components/document-editor/relationships/artifact-row";
import { SectionHeader } from "@/components/document-editor/relationships/section-header";
import {
  useDeleteArtifactLink,
  useResolvedArtifactLinks,
} from "@/hooks/queries/use-artifact-links";
import {
  type FlattenedArtifactRow,
  flattenAssociatedArtifacts,
} from "./flatten-associated-artifacts";

type AssociatedArtifactsSectionProps = {
  prdId: string;
};

/**
 * Flat, always-expanded list of all Documents transitively produced by a PRD —
 * typically Features at depth 1 and their Plans at depth 2, but renders
 * any depth so that future downstream doc types appear automatically.
 * Parent/child relationships are conveyed purely through indentation.
 */
export function AssociatedArtifactsSection({
  prdId,
}: Readonly<AssociatedArtifactsSectionProps>) {
  const [isOpen, setIsOpen] = useState(true);

  const { data: resolvedLinks = [] } = useResolvedArtifactLinks(prdId, {
    direction: LinkDirection.Target,
    linkType: LinkType.Produces,
    mode: LinkQueryMode.Tree,
  });

  const flattened = useMemo(
    () => flattenAssociatedArtifacts(prdId, resolvedLinks),
    [prdId, resolvedLinks]
  );

  return (
    <div className="bg-background">
      <SectionHeader
        isOpen={isOpen}
        onToggle={() => setIsOpen((prev) => !prev)}
        title="Associated Artifacts"
      />
      {isOpen && <AssociatedArtifactsBody flattened={flattened} />}
    </div>
  );
}

type AssociatedArtifactsBodyProps = {
  flattened: FlattenedArtifactRow[];
};

function AssociatedArtifactsBody({
  flattened,
}: Readonly<AssociatedArtifactsBodyProps>) {
  const deleteArtifactLink = useDeleteArtifactLink();

  if (flattened.length === 0) {
    return (
      <p className="py-3 text-base text-muted-foreground">
        No associated features yet. Generate features from this PRD to get
        started.
      </p>
    );
  }
  return (
    <div className="flex flex-col border-t">
      {flattened.map((row) => (
        <ArtifactRow
          artifact={endpointToDocument(row.endpoint)}
          depth={row.depth}
          key={row.endpoint.id}
          linkId={row.linkId}
          onDetach={(id) => deleteArtifactLink.mutate(id)}
        />
      ))}
    </div>
  );
}

/**
 * Adapts an ArtifactLinkEndpoint to the legacy Document shape that ArtifactRow
 * still expects. The endpoint omits some fields that ArtifactRow doesn't use
 * for navigation (assignee object, approver, etc.) so this lossy adapter is
 * acceptable here.
 */
function endpointToDocument(endpoint: ArtifactLinkEndpoint): Document {
  return {
    id: endpoint.id,
    organizationId: endpoint.organizationId,
    workstreamId: endpoint.workstreamId,
    projectId: endpoint.projectId,
    type: (endpoint.subtype ?? DocumentType.Feature) as DocumentType,
    title: endpoint.name,
    slug: endpoint.slug ?? "",
    fileName: null,
    status: (endpoint.status as DocumentStatus) ?? DocumentStatus.Draft,
    priority: endpoint.priority ?? Priority.Medium,
    latestVersion: 1,
    createdById: endpoint.createdById ?? "",
    assigneeId: endpoint.assigneeId,
    assignee: null,
    approverId: null,
    approver: null,
    tokenUsage: null,
    targetRepo: null,
    targetBranch: null,
    templateForType: null,
    sortOrder: endpoint.sortOrder,
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
  };
}
