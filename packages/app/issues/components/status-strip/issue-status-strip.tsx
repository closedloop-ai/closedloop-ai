"use client";

import { DocumentType } from "@repo/api/src/types/document";
import {
  ToolbarField,
  ToolbarSlug,
} from "@repo/app/documents/components/detail-design/artifact-canvas-toolbar";
// Feature slice -> documents slice: the strip is the shipped document
// metadata bar, so an issue's status, priority and owner edit the same way.
import {
  DocumentMetadataBar,
  type DocumentMetadataBarView,
} from "@repo/app/documents/components/document-metadata-bar";
import { formatCalendarDate } from "@repo/app/documents/components/feed-sidebar/sources/activity-snapshot";
import { ArtifactTypeIcons } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-icons";
import { CalendarIcon } from "lucide-react";

/**
 * ISS-12578 (DI-08): an issue's key fields, on the left of the issue canvas's
 * toolbar, which stays at the top of the canvas while the issue scrolls, on
 * the Artifact tab only (Ottilie, 2026-10-21, ISS-12576). Not in the page
 * header, which stays the same for every artifact type, and not on the other
 * tabs: Details shows the same fields with more room.
 *
 * It is the shipped `DocumentMetadataBar` (status with the issue lifecycle,
 * the person field, priority, attach files), led by the issue's slug and
 * followed by its due date. The slug carries the issue icon its sub-issue
 * rows carry, and the slug and due date are bordered like the controls
 * beside them (Nerys, 2026-10-22). Project, milestone, tags and repositories
 * are on the Details tab, which keeps it short (Nerys, 2026-10-21). The
 * person field keeps its label until DI-03 ruling 1 (ISS-12572: one person
 * field, labelled Owner).
 */
export function IssueStatusStrip({
  dueDate,
  issueId,
  metadata,
  slug,
}: Readonly<{
  dueDate?: Date | null;
  issueId: string;
  metadata: DocumentMetadataBarView;
  slug: string;
}>) {
  const due = dueDate ? formatCalendarDate(dueDate) : null;
  return (
    <DocumentMetadataBar
      // The canvas toolbar's row owns the vertical padding, so the issue's
      // toolbar is as tall as the document's.
      className="py-0"
      documentId={issueId}
      documentType={DocumentType.Feature}
      leading={<ToolbarSlug icon={ArtifactTypeIcons.Issue} slug={slug} />}
      metadata={metadata}
      showRepositories={false}
      showTags={false}
    >
      {due ? (
        <ToolbarField>
          <CalendarIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          {/* The field's shipped label, as on the Branch and Session
              Details tabs and the documents table's due date cell. */}
          <span className="text-muted-foreground">Due date</span>
          <span>{due}</span>
        </ToolbarField>
      ) : null}
    </DocumentMetadataBar>
  );
}
