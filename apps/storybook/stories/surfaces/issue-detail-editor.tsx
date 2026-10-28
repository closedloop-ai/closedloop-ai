/**
 * `StoryIssueEditor` for `issue-detail.stories.tsx` — split into its own
 * file to keep every file in this Surface under the repo's 1,000-line
 * ceiling (`noExcessiveLinesPerFile`), not for any reuse reason. See that
 * file's own doc comment for the full account of the Clerk/flag walls this
 * Surface hits.
 *
 * `StoryIssueEditor` is the real route's own `issue-editor.tsx` copied
 * verbatim except: its own `useOrgSlug()` → `ORG_SLUG` and its
 * `IssueEditorHeader` → `StoryIssueEditorHeader` (from
 * `./issue-detail-header`).
 *
 * Every other piece composed here — `DocumentEditorScaffold`,
 * `CustomFieldsSection`, `ContextSection`, `PlanSection`, `BranchesSection`
 * — is the real, unmodified `packages/app`/`apps/app` export, confirmed
 * Clerk-free by reading its own imports.
 */

import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { DocumentDetail } from "@repo/api/src/types/document";
import { CustomFieldsSection } from "@repo/app/custom-fields/components/custom-fields-section";
import {
  DocumentEditorScaffold,
  type ScaffoldSlotContext,
} from "@repo/app/documents/components/document-editor-scaffold";
import { FeedArtifactType } from "@repo/app/documents/components/feed-sidebar/types";
import { BranchesSection } from "@repo/app/documents/components/relationships/branches-section";
import { useCommentPermalinkBuilder } from "@repo/app/documents/components/use-comment-permalink-builder";
import { ContextSection } from "@repo/app/documents/editors/issues/detail/components/context-section";
import { PlanSection } from "@repo/app/documents/editors/issues/detail/components/plan-section";
import { useIssueState } from "@repo/app/documents/editors/issues/detail/use-issue-state";
import { ORG_SLUG } from "./app-shell";
import { StoryIssueEditorHeader } from "./issue-detail-header";

type StoryIssueEditorProps = {
  document: DocumentDetail;
  currentVersion: number;
  onVersionChange: (version: number) => void;
};

function getFeatureRedirectPath(
  feature: DocumentDetail,
  orgSlug: string
): string {
  const teamId = feature.project?.teams?.[0]?.id;
  const projectId = feature.project?.id;
  if (teamId && projectId) {
    return `/${orgSlug}/teams/${teamId}/projects/${projectId}`;
  }
  return `/${orgSlug}`;
}

/** Story substitute for `IssueEditor` (`@repo/app/documents/editors/issues/detail/issue-editor`) —
 * the real composition verbatim: `DocumentEditorScaffold` (real,
 * unmodified) composing `CustomFieldsSection`, `ContextSection`,
 * `PlanSection`, `BranchesSection` (all real, unmodified) — with
 * `useOrgSlug()` swapped for `ORG_SLUG`, and `IssueEditorHeader` swapped
 * for its Story substitute. See the file doc comment for why each
 * substitution is needed and why nothing else is. */
export function StoryIssueEditor({
  document,
  currentVersion,
  onVersionChange,
}: Readonly<StoryIssueEditorProps>) {
  const feature = document;
  const orgSlug = ORG_SLUG;
  const { linkedPlanId } = useIssueState(feature);

  const redirectPath = getFeatureRedirectPath(feature, orgSlug);
  const buildPermalinkUrl = useCommentPermalinkBuilder({
    documentType: feature.type,
    documentSlug: feature.slug,
    orgSlug,
  });

  return (
    <DocumentEditorScaffold
      buildPermalinkUrl={buildPermalinkUrl}
      currentVersion={currentVersion}
      deleteDialogTitle="Issue"
      detailsSections={(ctx: ScaffoldSlotContext) => (
        <>
          <CustomFieldsSection
            entityId={feature.id}
            entityType={CustomFieldEntityType.Document}
            values={feature.customFields}
          />
          <ContextSection
            featureId={feature.id}
            latestContent={ctx.latestContentForAttachmentWarnings}
            projectId={feature.projectId ?? undefined}
            renderedContent={ctx.selectedContentForAttachmentVisibility}
          />
          <PlanSection feature={feature} />
          <BranchesSection
            documentId={feature.id}
            planId={linkedPlanId}
            projectId={feature.projectId ?? ""}
          />
        </>
      )}
      document={feature}
      feedArtifactType={FeedArtifactType.Feature}
      hideRepositoriesInMetadataBar
      moveDialogTeamId={feature.project?.teams?.[0]?.id ?? null}
      onVersionChange={onVersionChange}
      redirectPath={redirectPath}
      renderHeader={(ctx: ScaffoldSlotContext) => (
        <StoryIssueEditorHeader
          displayTitle={feature.title}
          feature={feature}
          onDelete={ctx.chrome.openDeleteDialog}
          onMoveToProject={ctx.chrome.openMoveDialog}
          onToggleMetadataPanel={ctx.chrome.toggleMetadataPanel}
        />
      )}
    />
  );
}
