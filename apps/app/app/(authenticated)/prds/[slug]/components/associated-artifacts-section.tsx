"use client";

import type { Document } from "@repo/api/src/types/document";
import type { LinkedEntity } from "@repo/api/src/types/entity-link";
import {
  EntityType,
  LinkDirection,
  LinkQueryMode,
  LinkType,
} from "@repo/api/src/types/entity-link";
import { isDisplayableSlug } from "@repo/api/src/types/slug";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import { cn } from "@repo/design-system/lib/utils";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AssigneeAvatar } from "@/components/assignee-avatar";
import { SectionHeader } from "@/components/document-editor/relationships/section-header";
import { useLinkedEntities } from "@/hooks/queries/use-entity-links";
import { getDocumentRoute } from "@/lib/document-navigation";
import {
  DOCUMENT_STATUS_TO_ICON,
  DOCUMENT_TYPE_BADGE_LABELS,
  DOCUMENT_TYPE_ICONS,
} from "@/lib/project-constants";

type AssociatedArtifactsSectionProps = {
  prdId: string;
};

type TreeNode = {
  document: Document;
  children: TreeNode[];
};

const DEFAULT_EXPAND_DEPTH = 1;
const INDENT_PER_DEPTH_PX = 20;

/**
 * Nested list of all Documents transitively produced by a PRD —
 * typically Features at depth 1 and their Plans at depth 2, but renders
 * any depth so that future downstream doc types appear automatically.
 */
export function AssociatedArtifactsSection({
  prdId,
}: Readonly<AssociatedArtifactsSectionProps>) {
  const { data: linkedEntities = [] } = useLinkedEntities(
    prdId,
    EntityType.Document,
    {
      direction: LinkDirection.Target,
      linkType: LinkType.Produces,
      mode: LinkQueryMode.Tree,
    }
  );

  const tree = useMemo(
    () => buildTree(prdId, linkedEntities),
    [prdId, linkedEntities]
  );

  return (
    <div className="bg-background">
      <SectionHeader title="Associated Artifacts" />
      {tree.length === 0 ? (
        <p className="py-3 text-base text-muted-foreground">
          No associated features yet. Generate features from this PRD to get
          started.
        </p>
      ) : (
        <div className="flex flex-col">
          {tree.map((node) => (
            <AssociatedArtifactRow
              depth={1}
              key={node.document.id}
              node={node}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type AssociatedArtifactRowProps = {
  node: TreeNode;
  depth: number;
};

function AssociatedArtifactRow({
  node,
  depth,
}: Readonly<AssociatedArtifactRowProps>) {
  const { document: artifact, children } = node;
  const [isExpanded, setIsExpanded] = useState(depth <= DEFAULT_EXPAND_DEPTH);

  const Icon = DOCUMENT_TYPE_ICONS[artifact.type];
  const badgeLabel = DOCUMENT_TYPE_BADGE_LABELS[artifact.type];
  const statusIconStatus = DOCUMENT_STATUS_TO_ICON[artifact.status];
  const route = getDocumentRoute(artifact);
  const hasChildren = children.length > 0;
  const indentPx = (depth - 1) * INDENT_PER_DEPTH_PX;

  return (
    <>
      <div
        className="flex items-center px-2 py-1"
        style={{ paddingLeft: `${indentPx + 8}px` }}
      >
        <div className="flex shrink-0 items-center">
          {hasChildren ? (
            <button
              aria-label={isExpanded ? "Collapse" : "Expand"}
              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent"
              onClick={() => setIsExpanded((prev) => !prev)}
              type="button"
            >
              {isExpanded ? (
                <ChevronDownIcon className="h-3.5 w-3.5" />
              ) : (
                <ChevronRightIcon className="h-3.5 w-3.5" />
              )}
            </button>
          ) : (
            <span className="inline-block h-5 w-5" />
          )}
        </div>
        <Link
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-md hover:bg-accent"
          )}
          href={route ?? "#"}
        >
          <div className="flex shrink-0 items-center p-1">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </div>
          <span className="min-w-[60px] shrink-0 truncate font-medium text-muted-foreground text-xs">
            {isDisplayableSlug(artifact.slug) ? artifact.slug : badgeLabel}
          </span>
          <span className="truncate px-1 font-medium text-sm">
            {artifact.title}
          </span>
        </Link>
        <div className="flex h-9 shrink-0 items-center gap-2">
          <AssigneeAvatar assignee={artifact.assignee} />
          <StatusIcon size={20} status={statusIconStatus} />
        </div>
      </div>
      {hasChildren && isExpanded
        ? children.map((child) => (
            <AssociatedArtifactRow
              depth={depth + 1}
              key={child.document.id}
              node={child}
            />
          ))
        : null}
    </>
  );
}

/**
 * Flat LinkedEntity list (from a Tree query starting at `rootId`) → nested tree.
 * Each link encodes a parent→child edge via sourceId/targetId; we index by
 * sourceId and walk from the root. Cycles and self-links are guarded.
 */
function buildTree(rootId: string, linkedEntities: LinkedEntity[]): TreeNode[] {
  const childrenByParent = new Map<string, Document[]>();

  for (const link of linkedEntities) {
    if (
      link.resolvedEntity?.type !== EntityType.Document ||
      link.targetType !== EntityType.Document
    ) {
      continue;
    }
    const child = link.resolvedEntity.entity;
    const existing = childrenByParent.get(link.sourceId) ?? [];
    if (!existing.some((doc) => doc.id === child.id)) {
      existing.push(child);
    }
    childrenByParent.set(link.sourceId, existing);
  }

  function walk(parentId: string, visited: Set<string>): TreeNode[] {
    const directChildren = childrenByParent.get(parentId) ?? [];
    return directChildren
      .filter((doc) => !visited.has(doc.id))
      .map((doc) => {
        const nextVisited = new Set(visited);
        nextVisited.add(doc.id);
        return {
          document: doc,
          children: walk(doc.id, nextVisited),
        };
      });
  }

  return walk(rootId, new Set([rootId]));
}
