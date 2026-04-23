"use client";

import type { Document } from "@repo/api/src/types/document";
import type { LinkedEntity } from "@repo/api/src/types/entity-link";
import {
  EntityType,
  LinkDirection,
  LinkQueryMode,
  LinkType,
} from "@repo/api/src/types/entity-link";
import { useMemo, useState } from "react";
import { ArtifactRow } from "@/components/document-editor/relationships/artifact-row";
import { SectionHeader } from "@/components/document-editor/relationships/section-header";
import {
  useDeleteEntityLink,
  useLinkedEntities,
} from "@/hooks/queries/use-entity-links";

type AssociatedArtifactsSectionProps = {
  prdId: string;
};

type TreeNode = {
  document: Document;
  children: TreeNode[];
  /** EntityLink id connecting this document to its parent in the tree. */
  linkId: string | null;
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

  const { data: linkedEntities = [] } = useLinkedEntities(
    prdId,
    EntityType.Document,
    {
      direction: LinkDirection.Target,
      linkType: LinkType.Produces,
      mode: LinkQueryMode.Tree,
    }
  );

  const flattened = useMemo(
    () => flattenTree(buildTree(prdId, linkedEntities)),
    [prdId, linkedEntities]
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

type FlattenedRow = {
  document: Document;
  linkId: string | null;
  depth: number;
};

type AssociatedArtifactsBodyProps = {
  flattened: FlattenedRow[];
};

function AssociatedArtifactsBody({
  flattened,
}: Readonly<AssociatedArtifactsBodyProps>) {
  const deleteEntityLink = useDeleteEntityLink();

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
          artifact={row.document}
          depth={row.depth}
          key={row.document.id}
          linkId={row.linkId}
          onDetach={(id) => deleteEntityLink.mutate(id)}
        />
      ))}
    </div>
  );
}

function flattenTree(nodes: TreeNode[], depth = 1): FlattenedRow[] {
  const rows: FlattenedRow[] = [];
  for (const node of nodes) {
    rows.push({ document: node.document, linkId: node.linkId, depth });
    if (node.children.length > 0) {
      rows.push(...flattenTree(node.children, depth + 1));
    }
  }
  return rows;
}

/**
 * Flat LinkedEntity list (from a Tree query starting at `rootId`) → nested tree.
 * Each link encodes a parent→child edge via sourceId/targetId; we index by
 * sourceId and walk from the root. Cycles and self-links are guarded.
 */
function buildTree(rootId: string, linkedEntities: LinkedEntity[]): TreeNode[] {
  const childrenByParent = new Map<
    string,
    { doc: Document; linkId: string }[]
  >();

  for (const link of linkedEntities) {
    if (
      link.resolvedEntity?.type !== EntityType.Document ||
      link.targetType !== EntityType.Document
    ) {
      continue;
    }
    const child = link.resolvedEntity.entity;
    const existing = childrenByParent.get(link.sourceId) ?? [];
    if (!existing.some((entry) => entry.doc.id === child.id)) {
      existing.push({ doc: child, linkId: link.id });
    }
    childrenByParent.set(link.sourceId, existing);
  }

  function walk(parentId: string, visited: Set<string>): TreeNode[] {
    const directChildren = childrenByParent.get(parentId) ?? [];
    return directChildren
      .filter((entry) => !visited.has(entry.doc.id))
      .map((entry) => {
        const nextVisited = new Set(visited);
        nextVisited.add(entry.doc.id);
        return {
          document: entry.doc,
          linkId: entry.linkId,
          children: walk(entry.doc.id, nextVisited),
        };
      });
  }

  return walk(rootId, new Set([rootId]));
}
