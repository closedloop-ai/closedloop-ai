"use client";

import { type Document, DocumentType } from "@repo/api/src/types/document";
import type { LinkedEntity } from "@repo/api/src/types/entity-link";
import {
  EntityType,
  LinkDirection,
  LinkType,
} from "@repo/api/src/types/entity-link";
import { useState } from "react";
import { ArtifactRow } from "@/components/document-editor/relationships/artifact-row";
import { SectionHeader } from "@/components/document-editor/relationships/section-header";
import { useLinkedEntities } from "@/hooks/queries/use-entity-links";

type PlanContextSectionProps = {
  planId: string;
};

/**
 * "Context" section for the Plan detail page — shows the parent Feature or
 * PRD that produced this plan (Feature|PRD → PRODUCES → Plan).
 */
export function PlanContextSection({
  planId,
}: Readonly<PlanContextSectionProps>) {
  const [isOpen, setIsOpen] = useState(true);

  const { data: linkedEntities = [] } = useLinkedEntities(
    planId,
    EntityType.Document,
    {
      direction: LinkDirection.Source,
      linkType: LinkType.Produces,
    }
  );

  const parentSource = findParentSource(linkedEntities);

  return (
    <div className="bg-background">
      <SectionHeader
        isOpen={isOpen}
        onToggle={() => setIsOpen((prev) => !prev)}
        title="Context"
      />
      {isOpen && <PlanContextBody parentSource={parentSource} />}
    </div>
  );
}

type PlanContextBodyProps = {
  parentSource: Document | null;
};

function PlanContextBody({ parentSource }: Readonly<PlanContextBodyProps>) {
  if (parentSource) {
    return (
      <div className="flex flex-col border-t">
        <ArtifactRow artifact={parentSource} />
      </div>
    );
  }
  return (
    <p className="py-3 text-base text-muted-foreground">
      No linked context source
    </p>
  );
}

function findParentSource(linkedEntities: LinkedEntity[]): Document | null {
  for (const linked of linkedEntities) {
    if (linked.resolvedEntity?.type !== EntityType.Document) {
      continue;
    }
    const doc = linked.resolvedEntity.entity;
    if (doc.type === DocumentType.Feature || doc.type === DocumentType.Prd) {
      return doc;
    }
  }
  return null;
}
