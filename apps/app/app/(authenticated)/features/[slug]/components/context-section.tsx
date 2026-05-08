"use client";

import {
  type ArtifactLinkEndpoint,
  ArtifactType,
  LinkDirection,
} from "@repo/api/src/types/artifact";
import type { FileAttachment } from "@repo/api/src/types/attachment";
import type { DocumentWithWorkstream } from "@repo/api/src/types/document";
import { isDisplayableSlug } from "@repo/api/src/types/slug";
import { Button } from "@repo/design-system/components/ui/button";
import { toast } from "@repo/design-system/components/ui/sonner";
import { FileIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { ArtifactRow } from "@/components/document-editor/relationships/artifact-row";
import { OverflowMenu } from "@/components/document-editor/relationships/overflow-menu";
import { SectionHeader } from "@/components/document-editor/relationships/section-header";
import {
  useDeleteArtifactLink,
  useResolvedArtifactLinks,
} from "@/hooks/queries/use-artifact-links";
import {
  useAttachments,
  useDeleteAttachment,
} from "@/hooks/queries/use-attachments";
import {
  useDocument,
  useDocumentsByProject,
} from "@/hooks/queries/use-documents";
import {
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
  const [isOpen, setIsOpen] = useState(true);

  const { data: resolvedLinks = [] } = useResolvedArtifactLinks(featureId, {
    direction: LinkDirection.Source,
  });
  const { data: featureAttachments = [] } = useAttachments(featureId);
  const { data: projectDocuments = [] } = useDocumentsByProject(
    projectId ?? "",
    { enabled: !!projectId }
  );
  const deleteFeatureAttachment = useDeleteAttachment(featureId);
  const deleteLink = useDeleteArtifactLink();

  function handleUnlink(linkId: string) {
    deleteLink.mutate(linkId, {
      onSuccess: () => {
        toast.success("Item unlinked");
      },
    });
  }

  const documentsById = useMemo(
    () => new Map(projectDocuments.map((doc) => [doc.id, doc])),
    [projectDocuments]
  );

  // `direction: LinkDirection.Source` already returns links where the
  // feature is the target and the other artifact is the producing source,
  // so we only need to gate on the source type here (PR/deployment links
  // belong in Branches / Preview sections).
  const contextLinks = useMemo(
    () =>
      resolvedLinks.filter(
        (link) => link.source.type === ArtifactType.Document
      ),
    [resolvedLinks]
  );

  // Collect IDs of already-linked documents so the dialog can exclude them
  const linkedArtifactIds = useMemo(() => {
    const ids = new Set<string>();
    for (const link of contextLinks) {
      ids.add(link.source.id);
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
            documentsById={documentsById}
            featureAttachments={featureAttachments}
            onAdd={() => setShowAddDialog(true)}
            onDeleteAttachment={(id) => deleteFeatureAttachment.mutate(id)}
            onUnlink={handleUnlink}
            resolvedSourceLinks={contextLinks}
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
  documentsById: Map<string, DocumentWithWorkstream>;
  featureAttachments: FileAttachment[];
  resolvedSourceLinks: ReturnType<typeof useResolvedArtifactLinks>["data"];
  onAdd: () => void;
  onUnlink: (linkId: string) => void;
  onDeleteAttachment: (attachmentId: string) => void;
};

function ContextBody({
  documentsById,
  featureAttachments,
  resolvedSourceLinks = [],
  onAdd,
  onUnlink,
  onDeleteAttachment,
}: Readonly<ContextBodyProps>) {
  if (resolvedSourceLinks.length === 0 && featureAttachments.length === 0) {
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

  return (
    <div className="flex flex-col">
      {resolvedSourceLinks.map((link) => {
        const doc = documentsById.get(link.source.id);
        if (doc) {
          return (
            <ArtifactRow
              artifact={doc}
              key={link.id}
              linkId={link.id}
              onDetach={onUnlink}
            />
          );
        }
        // Document lives in a different project. Render from the
        // resolved link endpoint so cross-project context still shows.
        return (
          <CrossProjectDocumentRow
            endpoint={link.source}
            key={link.id}
            linkId={link.id}
            onUnlink={onUnlink}
          />
        );
      })}
      {featureAttachments.map((attachment) => (
        <AttachmentRow
          attachment={attachment}
          key={attachment.id}
          onDelete={() => onDeleteAttachment(attachment.id)}
        />
      ))}
    </div>
  );
}

/**
 * Renders a context row for a document that isn't in the current feature's
 * project. Fetches the full document by id so status/assignee render with
 * full fidelity; falls back to the resolved-link endpoint while loading.
 */
function CrossProjectDocumentRow({
  endpoint,
  linkId,
  onUnlink,
}: Readonly<{
  endpoint: ArtifactLinkEndpoint;
  linkId: string;
  onUnlink: (linkId: string) => void;
}>) {
  const { data: artifact } = useDocument(endpoint.id);
  if (artifact) {
    return (
      <ArtifactRow
        artifact={artifact as DocumentWithWorkstream}
        linkId={linkId}
        onDetach={onUnlink}
      />
    );
  }
  // Fallback: render from the endpoint's minimal fields while the full
  // document load is pending (or if the user lacks access). Omits status +
  // assignee since those aren't on the endpoint shape.
  const docType = endpoint.subtype;
  const Icon = docType ? DOCUMENT_TYPE_ICONS[docType] : FileIcon;
  const badgeLabel = docType ? DOCUMENT_TYPE_BADGE_LABELS[docType] : "Document";
  return (
    <div className="flex items-center px-2 py-1">
      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md">
        <div className="flex shrink-0 items-center p-1">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <span className="min-w-[60px] shrink-0 truncate font-medium text-muted-foreground text-xs">
          {isDisplayableSlug(endpoint.slug) ? endpoint.slug : badgeLabel}
        </span>
        <span className="truncate px-1 font-medium text-sm">
          {endpoint.name}
        </span>
      </div>
      <div className="flex h-9 shrink-0 items-center gap-2">
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
          <a
            className="hover:opacity-90"
            href={attachment.previewUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            {/* biome-ignore lint/performance/noImgElement: S3 presigned URLs are external/dynamic */}
            <img
              alt={attachment.filename}
              className="h-8 w-8 shrink-0 rounded object-cover"
              height={8}
              src={attachment.previewUrl}
              width={8}
            />
          </a>
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
