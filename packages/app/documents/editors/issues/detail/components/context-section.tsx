"use client";

import {
  type ArtifactLinkEndpoint,
  ArtifactType,
  LinkDirection,
} from "@repo/api/src/types/artifact";
import {
  AttachmentPurpose,
  type FileAttachment,
} from "@repo/api/src/types/attachment";
import type { DocumentWithProject } from "@repo/api/src/types/document";
import { isDisplayableSlug } from "@repo/api/src/types/slug";
import { ReferencedAttachmentDeleteDialog } from "@repo/app/documents/components/referenced-attachment-delete-dialog";
import { ArtifactRow } from "@repo/app/documents/components/relationships/artifact-row";
import { OverflowMenu } from "@repo/app/documents/components/relationships/overflow-menu";
import { AddContextDialog } from "@repo/app/documents/editors/issues/detail/components/add-context-dialog";
import {
  useDeleteArtifactLink,
  useResolvedArtifactLinks,
} from "@repo/app/documents/hooks/use-artifact-links";
import {
  useDeleteAttachment,
  useDocumentAttachments,
  useDownloadAttachment,
} from "@repo/app/documents/hooks/use-attachments";
import {
  useDocument,
  useDocumentsByProject,
} from "@repo/app/documents/hooks/use-documents";
import {
  INLINE_ATTACHMENT_BADGE_LABEL,
  isAttachmentReferencedByContent,
  selectListedAttachments,
} from "@repo/app/documents/lib/attachment-visibility";
import { formatAttachmentSize } from "@repo/app/documents/lib/format-attachment-size";
import {
  DOCUMENT_TYPE_BADGE_LABELS,
  DOCUMENT_TYPE_ICONS,
} from "@repo/app/projects/lib/project-constants";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { SectionHeader } from "@repo/design-system/components/ui/section-header";
import { toast } from "@repo/design-system/components/ui/sonner";
import { DownloadIcon, FileIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";

type ContextSectionProps = {
  featureId: string;
  active?: boolean;
  projectId: string | undefined;
  /**
   * The scaffold's `latestContentForAttachmentWarnings`, so this panel and the
   * document's own attachments row agree about which inline images the body
   * already renders. Reading `latestVersionContent` here instead would make the
   * two disagree on an unsaved paste.
   */
  latestContent?: string;
  /**
   * The scaffold's `selectedContentForAttachmentVisibility` — the body on
   * screen, whose rendered inline images this panel hides. Separate from
   * `latestContent` so a historical view hides what THAT version renders while
   * the delete warning still asks about the latest saved body.
   */
  renderedContent?: string;
};

export function ContextSection({
  featureId,
  active = true,
  projectId,
  latestContent,
  renderedContent,
}: Readonly<ContextSectionProps>) {
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [isOpen, setIsOpen] = useState(true);

  const { data: resolvedLinks = [] } = useResolvedArtifactLinks(featureId, {
    enabled: active,
    direction: LinkDirection.Source,
  });
  const { data: allAttachments = [] } = useDocumentAttachments(featureId, {
    enabled: active,
  });
  const { data: projectDocuments = [] } = useDocumentsByProject(
    projectId ?? "",
    { enabled: active && !!projectId }
  );
  const deleteFeatureAttachment = useDeleteAttachment(featureId);
  const downloadAttachment = useDownloadAttachment();
  const deleteLink = useDeleteArtifactLink();
  const [referencedDeleteTarget, setReferencedDeleteTarget] =
    useState<FileAttachment | null>(null);

  // Filtered HERE, not in ContextBody: that component decides its empty state
  // from the list it receives, so filtering downstream would leave it rendering
  // a populated section with no rows in it.
  const featureAttachments = useMemo(
    () =>
      selectListedAttachments(allAttachments, renderedContent ?? latestContent),
    [allAttachments, renderedContent, latestContent]
  );

  // Same guard the document's attachments row applies. Before ISS-8036 this
  // panel listed `context` rows only, so it could never reach an image the body
  // renders; now that it lists `inline` rows, deleting one unwarned would break
  // that image.
  function handleDeleteAttachment(attachmentId: string) {
    const attachment = featureAttachments.find(
      (candidate) => candidate.id === attachmentId
    );
    if (
      attachment &&
      isAttachmentReferencedByContent(latestContent, attachmentId)
    ) {
      setReferencedDeleteTarget(attachment);
      return;
    }
    deleteFeatureAttachment.mutate(attachmentId);
  }

  function handleConfirmReferencedDelete() {
    if (referencedDeleteTarget) {
      deleteFeatureAttachment.mutate(referencedDeleteTarget.id);
      setReferencedDeleteTarget(null);
    }
  }

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
            aria-label="Add context"
            onClick={() => setShowAddDialog(true)}
            size="icon-sm"
            variant="ghost"
          >
            <PlusIcon className="h-4 w-4" />
          </Button>
        </SectionHeader>
        {isOpen && (
          <ContextBody
            active={active}
            documentsById={documentsById}
            featureAttachments={featureAttachments}
            onAdd={() => setShowAddDialog(true)}
            onDeleteAttachment={handleDeleteAttachment}
            onDownloadAttachment={(attachmentId) =>
              downloadAttachment.mutate({ attachmentId, documentId: featureId })
            }
            onUnlink={handleUnlink}
            resolvedSourceLinks={contextLinks}
          />
        )}
      </div>

      <ReferencedAttachmentDeleteDialog
        onCancel={() => setReferencedDeleteTarget(null)}
        onConfirm={handleConfirmReferencedDelete}
        target={referencedDeleteTarget}
      />

      <AddContextDialog
        excludeArtifactIds={linkedArtifactIds}
        featureId={featureId}
        onOpenChange={setShowAddDialog}
        open={active && showAddDialog}
        projectId={projectId}
      />
    </>
  );
}

type ContextBodyProps = {
  active?: boolean;
  documentsById: Map<string, DocumentWithProject>;
  featureAttachments: FileAttachment[];
  resolvedSourceLinks: ReturnType<typeof useResolvedArtifactLinks>["data"];
  onAdd: () => void;
  onUnlink: (linkId: string) => void;
  onDeleteAttachment: (attachmentId: string) => void;
  onDownloadAttachment: (attachmentId: string) => void;
};

function ContextBody({
  active = true,
  documentsById,
  featureAttachments,
  resolvedSourceLinks = [],
  onAdd,
  onUnlink,
  onDeleteAttachment,
  onDownloadAttachment,
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
            active={active}
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
          onDownload={() => onDownloadAttachment(attachment.id)}
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
  active = true,
  endpoint,
  linkId,
  onUnlink,
}: Readonly<{
  active?: boolean;
  endpoint: ArtifactLinkEndpoint;
  linkId: string;
  onUnlink: (linkId: string) => void;
}>) {
  const { data: artifact } = useDocument(endpoint.id, undefined, {
    enabled: active,
  });
  if (artifact) {
    return (
      <ArtifactRow
        artifact={artifact as DocumentWithProject}
        linkId={linkId}
        onDetach={onUnlink}
      />
    );
  }
  // Fallback: identity only (slug + name) while the full document load is
  // pending, or if the user lacks access. Status and assignee are deliberately
  // withheld rather than approximated — a half-loaded row that states them
  // would be indistinguishable from an authoritative one.
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
  onDownload,
}: Readonly<{
  attachment: FileAttachment;
  onDelete: () => void;
  onDownload: () => void;
}>) {
  const sizeLabel = formatAttachmentSize(attachment.sizeBytes);

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
        {attachment.purpose === AttachmentPurpose.Inline ? (
          <Badge className="shrink-0" variant="muted">
            {INLINE_ATTACHMENT_BADGE_LABEL}
          </Badge>
        ) : null}
      </div>
      <Button
        // The thumbnail only ever OPENED an image; this is the control that
        // saves it, and the one an image had no way to reach at all (ISS-8036).
        aria-label={`Download ${attachment.filename}`}
        // `focus-visible:` keeps the reveal reachable by keyboard: without it
        // this control is a focus stop that renders nothing (WCAG 2.4.7).
        className="opacity-0 touch:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
        onClick={onDownload}
        size="icon-sm"
        variant="ghost"
      >
        <DownloadIcon className="h-3.5 w-3.5 text-muted-foreground" />
      </Button>
      <Button
        aria-label="Remove attachment"
        // Touch pointers have no hover to reveal the remove control, so
        // `touch:opacity-100` keeps it visible; mouse hover reveal is unchanged.
        className="opacity-0 touch:opacity-100 group-hover:opacity-100"
        onClick={onDelete}
        size="icon-sm"
        variant="ghost"
      >
        <Trash2Icon className="h-3.5 w-3.5 text-muted-foreground" />
      </Button>
    </div>
  );
}
