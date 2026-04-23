"use client";

import type { LinkedEntity } from "@repo/api/src/types/entity-link";
import { EntityType, LinkDirection } from "@repo/api/src/types/entity-link";
import { Button } from "@repo/design-system/components/ui/button";
import { toast } from "@repo/design-system/components/ui/sonner";
import { PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { ArtifactRow } from "@/components/document-editor/relationships/artifact-row";
import { SectionHeader } from "@/components/document-editor/relationships/section-header";
import {
  useDeleteEntityLink,
  useLinkedEntities,
} from "@/hooks/queries/use-entity-links";
import { AddContextDialog } from "./add-context-dialog";

type ContextSectionProps = {
  featureId: string;
  projectId: string | undefined;
};

export function ContextSection({
  featureId,
  projectId,
}: Readonly<ContextSectionProps>) {
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [isOpen, setIsOpen] = useState(true);

  const { data: linkedEntities = [] } = useLinkedEntities(
    featureId,
    EntityType.Document,
    { direction: LinkDirection.Source }
  );
  const deleteLink = useDeleteEntityLink();

  function handleUnlink(linkId: string) {
    deleteLink.mutate(linkId, {
      onSuccess: () => {
        toast.success("Item unlinked");
      },
    });
  }

  // Filter to only artifact and feature source links (not external links — those go in Branches)
  const contextLinks = linkedEntities.filter(
    (linked) =>
      linked.resolvedEntity &&
      linked.resolvedEntity.type !== EntityType.ExternalLink
  );

  // Collect IDs of already-linked artifacts so the dialog can exclude them
  const linkedArtifactIds = useMemo(() => {
    const ids = new Set<string>();
    for (const linked of contextLinks) {
      if (linked.resolvedEntity?.type === EntityType.Document) {
        ids.add(linked.resolvedEntity.entity.id);
      }
    }
    return ids;
  }, [contextLinks]);

  return (
    <>
      <div className="bg-background">
        <SectionHeader
          isOpen={isOpen}
          onToggle={() => setIsOpen((prev) => !prev)}
          title="Context"
        >
          <Button
            onClick={() => setShowAddDialog(true)}
            size="icon-sm"
            variant="ghost"
          >
            <PlusIcon className="h-4 w-4" />
          </Button>
        </SectionHeader>
        {isOpen && (
          <ContextBody
            contextLinks={contextLinks}
            onAdd={() => setShowAddDialog(true)}
            onUnlink={handleUnlink}
          />
        )}
      </div>

      <AddContextDialog
        excludeArtifactIds={linkedArtifactIds}
        featureId={featureId}
        onOpenChange={setShowAddDialog}
        open={showAddDialog}
        projectId={projectId}
      />
    </>
  );
}

type ContextBodyProps = {
  contextLinks: LinkedEntity[];
  onAdd: () => void;
  onUnlink: (linkId: string) => void;
};

function ContextBody({
  contextLinks,
  onAdd,
  onUnlink,
}: Readonly<ContextBodyProps>) {
  if (contextLinks.length > 0) {
    return (
      <div className="flex flex-col border-t">
        {contextLinks.map((linked) => {
          if (linked.resolvedEntity?.type !== EntityType.Document) {
            return null;
          }
          return (
            <ArtifactRow
              artifact={linked.resolvedEntity.entity}
              key={linked.id}
              linkId={linked.id}
              onDetach={onUnlink}
            />
          );
        })}
      </div>
    );
  }
  return (
    <div className="flex items-center py-3">
      <div className="flex flex-1 flex-col gap-4">
        <p className="text-base text-muted-foreground">
          No context documents have been added to this feature
        </p>
        <div className="flex gap-4">
          <Button onClick={onAdd} size="sm" variant="outline">
            Add Documents
            <PlusIcon className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
