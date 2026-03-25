"use client";

import type { Artifact } from "@repo/api/src/types/artifact";
import type { FileAttachment } from "@repo/api/src/types/attachment";
import type { LinkedEntity } from "@repo/api/src/types/entity-link";
import { EntityType, LinkDirection } from "@repo/api/src/types/entity-link";
import type { Feature } from "@repo/api/src/types/feature";
import { isDisplayableSlug } from "@repo/api/src/types/slug";
import { Button } from "@repo/design-system/components/ui/button";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import { toast } from "@repo/design-system/components/ui/sonner";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import { FileIcon, PlusIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AssigneeAvatar } from "@/components/assignee-avatar";
import {
  useDeleteFeatureAttachment,
  useFeatureAttachments,
} from "@/hooks/queries/use-attachments";
import {
  useDeleteEntityLink,
  useLinkedEntities,
} from "@/hooks/queries/use-entity-links";
import { getArtifactRoute, getFeatureRoute } from "@/lib/artifact-navigation";
import {
  ARTIFACT_STATUS_TO_ICON,
  ARTIFACT_TYPE_BADGE_LABELS,
  ARTIFACT_TYPE_ICONS,
  FEATURE_ICON,
  FEATURE_STATUS_TO_ICON,
} from "@/lib/project-constants";
import { AddContextDialog } from "./add-context-dialog";
import { OverflowMenu } from "./overflow-menu";
import { SectionHeader } from "./section-header";

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
    EntityType.Feature,
    { direction: LinkDirection.Source }
  );
  const { data: featureAttachments = [] } = useFeatureAttachments(featureId);
  const deleteFeatureAttachment = useDeleteFeatureAttachment(featureId);
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
      if (linked.resolvedEntity?.type === EntityType.Artifact) {
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
        {contextLinks.length > 0 || featureAttachments.length > 0 ? (
          <div className="flex flex-col">
            {contextLinks.map((linked) => (
              <ContextRow
                key={linked.id}
                linked={linked}
                onUnlink={handleUnlink}
              />
            ))}
            {featureAttachments.map((attachment) => (
              <AttachmentRow
                attachment={attachment}
                key={attachment.id}
                onDelete={() => deleteFeatureAttachment.mutate(attachment.id)}
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

  switch (resolved.type) {
    case EntityType.Artifact: {
      return (
        <ArtifactRow
          artifact={resolved.entity}
          linkId={linked.id}
          onUnlink={onUnlink}
        />
      );
    }
    case EntityType.Feature: {
      return (
        <FeatureRow
          feature={resolved.entity}
          linkId={linked.id}
          onUnlink={onUnlink}
        />
      );
    }
    default: {
      return null;
    }
  }
}

type ArtifactRowProps = {
  artifact: Artifact;
  linkId: string;
  onUnlink: (linkId: string) => void;
};

function ArtifactRow({
  artifact,
  linkId,
  onUnlink,
}: Readonly<ArtifactRowProps>) {
  const Icon = ARTIFACT_TYPE_ICONS[artifact.type];
  const badgeLabel = ARTIFACT_TYPE_BADGE_LABELS[artifact.type];
  const statusIconStatus = ARTIFACT_STATUS_TO_ICON[artifact.status];
  const route = getArtifactRoute(artifact);

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

type FeatureRowProps = {
  feature: Feature;
  linkId: string;
  onUnlink: (linkId: string) => void;
};

function FeatureRow({ feature, linkId, onUnlink }: Readonly<FeatureRowProps>) {
  const Icon = FEATURE_ICON;
  const statusIconStatus = FEATURE_STATUS_TO_ICON[feature.status];
  const route = getFeatureRoute(feature);

  return (
    <div className="flex items-center gap-4 px-2 py-1">
      <Link
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md hover:bg-accent"
        href={route}
      >
        <div className="flex shrink-0 items-center p-1">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <span className="min-w-[60px] shrink-0 truncate font-medium text-muted-foreground text-xs">
          {isDisplayableSlug(feature.slug) ? feature.slug : "Feature"}
        </span>
        <span className="truncate px-1 font-medium text-sm">
          {feature.title}
        </span>
      </Link>
      <div className="flex h-9 shrink-0 items-center gap-2">
        <PriorityIcon priority={feature.priority} />
        <AssigneeAvatar assignee={feature.assignee} />
        <StatusIcon size={20} status={statusIconStatus} />
        <OverflowMenu linkId={linkId} onUnlink={onUnlink} />
      </div>
    </div>
  );
}

function AttachmentRow({
  attachment,
  onDelete,
}: Readonly<{ attachment: FileAttachment; onDelete: () => void }>) {
  const sizeLabel =
    attachment.sizeBytes < 1024 * 1024
      ? `${Math.ceil(attachment.sizeBytes / 1024)} KB`
      : `${(attachment.sizeBytes / (1024 * 1024)).toFixed(1)} MB`;

  return (
    <div className="group flex items-center px-2 py-1">
      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md">
        {attachment.previewUrl ? (
          /* biome-ignore lint/performance/noImgElement: S3 presigned URLs are external/dynamic */
          /* biome-ignore lint/correctness/useImageSize: dimensions set via CSS */
          <img
            alt={attachment.filename}
            className="h-8 w-8 shrink-0 rounded object-cover"
            height={8}
            src={attachment.previewUrl}
            width={8}
          />
        ) : (
          <div className="flex shrink-0 items-center p-1">
            <FileIcon className="h-4 w-4 text-muted-foreground" />
          </div>
        )}
        <span className="truncate px-1 font-medium text-sm">
          {attachment.filename}
        </span>
        <span className="shrink-0 text-muted-foreground text-xs">
          {sizeLabel}
        </span>
      </div>
      <Button
        className="opacity-0 group-hover:opacity-100"
        onClick={onDelete}
        size="icon-sm"
        variant="ghost"
      >
        <Trash2Icon className="h-3.5 w-3.5 text-muted-foreground" />
      </Button>
    </div>
  );
}
