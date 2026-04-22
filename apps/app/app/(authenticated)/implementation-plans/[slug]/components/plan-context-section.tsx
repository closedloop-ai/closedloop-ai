"use client";

import { type Document, DocumentType } from "@repo/api/src/types/document";
import type { LinkedEntity } from "@repo/api/src/types/entity-link";
import {
  EntityType,
  LinkDirection,
  LinkType,
} from "@repo/api/src/types/entity-link";
import { isDisplayableSlug } from "@repo/api/src/types/slug";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import Link from "next/link";
import { AssigneeAvatar } from "@/components/assignee-avatar";
import { SectionHeader } from "@/components/document-editor/relationships/section-header";
import { useLinkedEntities } from "@/hooks/queries/use-entity-links";
import { getDocumentRoute } from "@/lib/document-navigation";
import {
  DOCUMENT_STATUS_TO_ICON,
  DOCUMENT_TYPE_BADGE_LABELS,
  DOCUMENT_TYPE_ICONS,
} from "@/lib/project-constants";

type PlanContextSectionProps = {
  planId: string;
};

/**
 * "Context" section for the Plan detail page — shows the parent Feature that
 * produced this plan (Feature → PRODUCES → Plan).
 */
export function PlanContextSection({
  planId,
}: Readonly<PlanContextSectionProps>) {
  const { data: linkedEntities = [] } = useLinkedEntities(
    planId,
    EntityType.Document,
    {
      direction: LinkDirection.Source,
      linkType: LinkType.Produces,
    }
  );

  const parentFeature = findParentFeature(linkedEntities);

  return (
    <div className="bg-background">
      <SectionHeader title="Context" />
      {parentFeature ? (
        <ContextDocumentRow artifact={parentFeature} />
      ) : (
        <p className="py-3 text-base text-muted-foreground">
          No linked feature
        </p>
      )}
    </div>
  );
}

function findParentFeature(linkedEntities: LinkedEntity[]): Document | null {
  for (const linked of linkedEntities) {
    if (
      linked.resolvedEntity?.type === EntityType.Document &&
      linked.resolvedEntity.entity.type === DocumentType.Feature
    ) {
      return linked.resolvedEntity.entity;
    }
  }
  return null;
}

type ContextDocumentRowProps = {
  artifact: Document;
};

function ContextDocumentRow({ artifact }: Readonly<ContextDocumentRowProps>) {
  const Icon = DOCUMENT_TYPE_ICONS[artifact.type];
  const badgeLabel = DOCUMENT_TYPE_BADGE_LABELS[artifact.type];
  const statusIconStatus = DOCUMENT_STATUS_TO_ICON[artifact.status];
  const route = getDocumentRoute(artifact);

  return (
    <div className="flex items-center px-2 py-1">
      <Link
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md hover:bg-accent"
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
  );
}
