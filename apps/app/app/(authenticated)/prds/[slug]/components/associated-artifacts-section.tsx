"use client";

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
    () => flattenAssociatedArtifacts(prdId, linkedEntities),
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

type AssociatedArtifactsBodyProps = {
  flattened: FlattenedArtifactRow[];
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
