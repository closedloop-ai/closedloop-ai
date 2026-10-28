// gardener-support: test and story data, not shipped
"use client";

import { DOCUMENTS_PROTOTYPE_METRICS } from "@repo/app/artifacts/components/artifact-list-model";
import { DOCUMENT_STATUS_LABELS } from "@repo/app/shared/lib/artifact-status-labels";
import { DateRange } from "@repo/app/shared/lib/format-utils";
import type { ReactNode } from "react";
import { ArtifactListDesignShell } from "./artifact-list-design-shell";
import { DOCUMENTS_LIST_DESIGN_ROWS } from "./documents-list-design-fixtures";

/**
 * ISS-12586 (DI-16): the Documents List page shell on the Branches list
 * composition (see `ArtifactListDesignShell`). Nothing in production imports
 * it; Storybook renders it (Surfaces/Labs/Documents/Documents List).
 *
 * PRD-798's columns, after the Document identity (icon, slug, title) and the
 * favorite star: Owner, Status, Collaborators, Comments, Updated, Current
 * version and Tags. No Type column. Related Sessions is an open question in
 * PRD-798 and is left out. One summary card: the document count, with no
 * period change. The date toggle opens on All (PRD-798 L-02).
 */

export const DOCUMENTS_LIST_DESIGN_COLUMN_IDS = [
  "owner",
  "status",
  "collaborators",
  "comments",
  "updated",
  "currentVersion",
  "tags",
] as const;

export function DocumentsListDesignPreview({
  header,
}: Readonly<{
  /** The page header row; the app's route header in a full page. */
  header?: ReactNode;
}>) {
  const [countMetric] = DOCUMENTS_PROTOTYPE_METRICS;
  return (
    <ArtifactListDesignShell
      columnIds={DOCUMENTS_LIST_DESIGN_COLUMN_IDS}
      countMetric={countMetric}
      defaultDateRange={DateRange.AllTime}
      header={header}
      leadingLabel="Document"
      rows={DOCUMENTS_LIST_DESIGN_ROWS}
      statusLabels={DOCUMENT_STATUS_LABELS}
    />
  );
}
