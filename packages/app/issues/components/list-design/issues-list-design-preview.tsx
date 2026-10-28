// gardener-support: test and story data, not shipped
"use client";

import { ISSUES_PROTOTYPE_METRICS } from "@repo/app/artifacts/components/artifact-list-model";
import { ArtifactListDesignShell } from "@repo/app/documents/components/list-design/artifact-list-design-shell";
import { ISSUE_STATUS_LABELS } from "@repo/app/shared/lib/artifact-status-labels";
import type { ReactNode } from "react";
import { ISSUES_LIST_DESIGN_ROWS } from "./issues-list-design-fixtures";

/**
 * ISS-12586 (DI-16): the Issues List page shell on the Branches list
 * composition, the same shell as the Documents List
 * (`ArtifactListDesignShell`). Nothing in production imports it; Storybook
 * renders it (Surfaces/Labs/Issues/Issues List).
 *
 * After the Issue identity (slug and title) and the favorite star: Status
 * (the issue statuses), Priority, Assignee, Owner, Comments, Updated and
 * Tags. No Type column. One summary card: the issue count.
 */

export const ISSUES_LIST_DESIGN_COLUMN_IDS = [
  "status",
  "priority",
  "assignee",
  "owner",
  "comments",
  "updated",
  "tags",
] as const;

export function IssuesListDesignPreview({
  header,
}: Readonly<{
  /** The page header row; the app's route header in a full page. */
  header?: ReactNode;
}>) {
  const [countMetric] = ISSUES_PROTOTYPE_METRICS;
  return (
    <ArtifactListDesignShell
      columnIds={ISSUES_LIST_DESIGN_COLUMN_IDS}
      countMetric={countMetric}
      header={header}
      leadingLabel="Issue"
      rows={ISSUES_LIST_DESIGN_ROWS}
      statusLabels={ISSUE_STATUS_LABELS}
    />
  );
}
