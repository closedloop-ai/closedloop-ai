"use client";

import type { Document } from "@repo/api/src/types/document";
import type { LinkedEntity } from "@repo/api/src/types/entity-link";
import { EntityType, LinkDirection } from "@repo/api/src/types/entity-link";
import { isDisplayableSlug } from "@repo/api/src/types/slug";
import { Button } from "@repo/design-system/components/ui/button";
import { toast } from "@repo/design-system/components/ui/sonner";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AssigneeAvatar } from "@/components/assignee-avatar";
import { OverflowMenu } from "@/components/document-editor/relationships/overflow-menu";
import { SectionHeader } from "@/components/document-editor/relationships/section-header";
import {
  useDeleteEntityLink,
  useLinkedEntities,
} from "@/hooks/queries/use-entity-links";
import { getDocumentRoute } from "@/lib/document-navigation";
import {
  DOCUMENT_STATUS_TO_ICON,
  DOCUMENT_TYPE_BADGE_LABELS,
  DOCUMENT_TYPE_ICONS,
} from "@/lib/project-constants";
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
        <SectionHeader title="Context">
          <Button
            onClick={() => setShowAddDialog(true)}
            size="icon-sm"
            variant="ghost"
          >
            <PlusIcon className="h-4 w-4" />
          </Button>
        </SectionHeader>
        {contextLinks.length > 0 ? (
          <div className="flex flex-col">
            {contextLinks.map((linked) => (
              <ContextRow
                key={linked.id}
                linked={linked}
                onUnlink={handleUnlink}
              />
            ))}
          </div>
        ) : (
          <div className="flex items-center py-3">
            <div className="flex flex-1 flex-col gap-4">
              <p className="text-base text-muted-foreground">
                No context documents have been added to this feature
              </p>
              <div className="flex gap-4">
                <Button
                  onClick={() => setShowAddDialog(true)}
                  size="sm"
                  variant="outline"
                >
                  Add Documents
                  <PlusIcon className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
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

type ContextRowProps = {
  linked: LinkedEntity;
  onUnlink: (linkId: string) => void;
};

function ContextRow({ linked, onUnlink }: Readonly<ContextRowProps>) {
  const resolved = linked.resolvedEntity;
  if (!resolved) {
    return null;
  }

  if (resolved.type === EntityType.Document) {
    return (
      <DocumentRow
        artifact={resolved.entity}
        linkId={linked.id}
        onUnlink={onUnlink}
      />
    );
  }
  return null;
}

type DocumentRowProps = {
  artifact: Document;
  linkId: string;
  onUnlink: (linkId: string) => void;
};

function DocumentRow({
  artifact,
  linkId,
  onUnlink,
}: Readonly<DocumentRowProps>) {
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
        <OverflowMenu linkId={linkId} onUnlink={onUnlink} />
      </div>
    </div>
  );
}
