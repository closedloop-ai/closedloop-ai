"use client";

import {
  LinkDirection,
  LinkQueryMode,
  LinkType,
} from "@repo/api/src/types/artifact";
import { ArtifactRow } from "@repo/app/documents/components/relationships/artifact-row";
import {
  useDeleteArtifactLink,
  useResolvedArtifactLinks,
} from "@repo/app/documents/hooks/use-artifact-links";
import { endpointToDocument } from "@repo/app/documents/lib/artifact-row-adapter";
import { SectionHeader } from "@repo/design-system/components/ui/section-header";
import { useMemo, useState } from "react";
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
