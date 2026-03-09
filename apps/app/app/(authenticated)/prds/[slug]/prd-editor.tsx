"use client";

import {
  type ArtifactDetail,
  ArtifactType,
} from "@repo/api/src/types/artifact";
import { EntityType } from "@repo/api/src/types/entity-link";
import { InlinePresence, OptionalArtifactRoom } from "@repo/collaboration";
import { Button } from "@repo/design-system/components/ui/button";
import { toast } from "@repo/design-system/components/ui/sonner";
import { Toggle } from "@repo/design-system/components/ui/toggle";
import { MessageSquareDotIcon } from "lucide-react";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { NewPlanModal } from "@/app/(authenticated)/implementation-plans/components/new-plan-modal";
import { VersionSelector } from "@/app/(authenticated)/implementation-plans/components/version-selector";
import { CollaborativeEditor } from "@/components/artifact-editor/collaborative-editor";
import { EditorToolbarRow } from "@/components/artifact-editor/editor-toolbar-row";
import { SaveIndicator } from "@/components/artifact-editor/save-indicator";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { GenerationStatusBanner } from "@/components/generation-status-banner";
import { MoveArtifactDialog } from "@/components/move-artifact-dialog";
import { RenameDialog } from "@/components/rename-dialog";
import { useArtifactActions } from "@/hooks/artifact-editing/use-artifact-actions";
import { useArtifactContent } from "@/hooks/artifact-editing/use-artifact-content";
import { useArtifactMetadata } from "@/hooks/artifact-editing/use-artifact-metadata";
import { useArtifactUIState } from "@/hooks/artifact-editing/use-artifact-ui-state";
import { useEditorSession } from "@/hooks/artifact-editing/use-editor-session";
import {
  useInlineGeneratePRD,
  useRegenerateArtifact,
} from "@/hooks/queries/use-artifacts";
import { useRunLoop } from "@/hooks/queries/use-loops";
import type { PlanSource } from "../../implementation-plans/components/plan-source";
import { PRDEditorHeader } from "./components/prd-editor-header";
import { PRDMetadataPanel } from "./components/prd-metadata-panel";

type PRDEditorProps = {
  prd: ArtifactDetail;
  currentVersion: number;
  latestVersion: number;
  onVersionChange: (version: number) => void;
};

export function PRDEditor({
  prd,
  currentVersion,
  latestVersion,
  onVersionChange,
}: Readonly<PRDEditorProps>) {
  // Move dialog state
  const [showMoveDialog, setShowMoveDialog] = useState(false);

  // Comments panel toggle state
  const [showComments, setShowComments] = useState(true);

  const newPlanSource: PlanSource = useMemo(() => {
    return {
      ...prd,
      sourceType: EntityType.Artifact,
    };
  }, [prd]);

  const content = useArtifactContent({
    artifact: prd,
    onVersionCreated: () => {
      if (currentVersion !== latestVersion) {
        onVersionChange(latestVersion);
      }
    },
  });

  const session = useEditorSession({
    artifact: prd,
    currentVersion,
    latestVersion,
    content,
  });
  const prevThreadCount = useRef(session.openThreadCount);

  const metadata = useArtifactMetadata({
    artifact: prd,
  });

  const actions = useArtifactActions({
    artifact: prd,
    redirectPath: prd.project?.teams?.[0]?.id
      ? `/teams/${prd.project.teams[0].id}/projects/${prd.project.id}`
      : "/prds",
  });

  const uiState = useArtifactUIState({
    artifactType: ArtifactType.Prd,
  });

  // Type assertion: useArtifactUIState returns a union; narrow to the PRD/Issue branch
  const {
    showRenameDialog,
    setShowRenameDialog,
    openRenameDialog,
    showGeneratePlanModal,
    setShowGeneratePlanModal,
    openGeneratePlanModal,
  } = uiState;

  // PRD generation mutations
  const inlineGenerate = useInlineGeneratePRD();
  const deepGenerate = useRegenerateArtifact();
  const runLoop = useRunLoop();

  const handleQuickGenerate = () => {
    inlineGenerate.mutate(
      { artifactId: prd.id },
      {
        onSuccess: () => {
          toast.success("PRD generated successfully");
        },
        onError: (error) => {
          toast.error(`PRD generation failed: ${error.message}`);
        },
      }
    );
  };

  const handleDeepGenerate = () => {
    deepGenerate.mutate(
      { id: prd.id },
      {
        onSuccess: () => {
          toast.success("PRD generation started — check the status banner");
        },
        onError: (error) => {
          toast.error(`Failed to start PRD generation: ${error.message}`);
        },
      }
    );
  };

  const handleDecomposeFeatures = () => {
    runLoop.mutate(
      { artifactId: prd.id, command: "decompose" },
      {
        onSuccess: () => {
          toast.success("Feature decomposition started");
        },
      }
    );
  };

  // Auto-reveal comments when threads reappear after being fully resolved
  useEffect(() => {
    if (prevThreadCount.current === 0 && session.openThreadCount > 0) {
      setShowComments(true);
    }
    prevThreadCount.current = session.openThreadCount;
  }, [session.openThreadCount]);

  // Determine if any operation is pending
  const isPending =
    content.isSaving ||
    metadata.isUpdating ||
    actions.isDeleting ||
    actions.isRenaming;

  // Create version display component for header
  const versionDisplay = (
    <VersionSelector
      currentVersion={currentVersion}
      latestVersion={latestVersion}
      onVersionChange={(version) => {
        session.exitEditMode();
        onVersionChange(version);
      }}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Header */}
      <PRDEditorHeader
        isGenerating={inlineGenerate.isPending || deepGenerate.isPending}
        isPending={isPending}
        onDecomposeFeatures={handleDecomposeFeatures}
        onDeepGenerate={handleDeepGenerate}
        onDelete={uiState.openDeleteDialog}
        onExport={actions.handleDownload}
        onGeneratePlan={openGeneratePlanModal}
        onMove={() => setShowMoveDialog(true)}
        onQuickGenerate={handleQuickGenerate}
        onRename={openRenameDialog}
        onRestoreVersion={session.handleRestoreVersion}
        onToggleMetadataPanel={uiState.toggleMetadataPanel}
        prd={prd}
        showMetadataPanel={uiState.showMetadataPanel}
        showRestore={session.isViewingHistorical}
      />

      {/* Content area: toolbar + editor on left, metadata panel on right */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <OptionalArtifactRoom roomId={session.liveblocksRoomId}>
            {/* Toolbar Row */}
            <EditorToolbarRow
              leftContent={
                <>
                  {session.isEditing && session.liveblocksRoomId && (
                    <Suspense fallback={null}>
                      <InlinePresence />
                    </Suspense>
                  )}
                  {versionDisplay}
                  <SaveIndicator
                    isSaving={content.isSaving}
                    lastSaved={content.lastSaved}
                  />
                </>
              }
              rightContent={
                <>
                  {session.openThreadCount > 0 && (
                    <Toggle
                      className="px-3"
                      onPressedChange={setShowComments}
                      pressed={showComments}
                      size="sm"
                      variant="outline"
                    >
                      <MessageSquareDotIcon className="h-4 w-4" />
                      {session.openThreadCount}
                    </Toggle>
                  )}
                  {session.isEditing ? (
                    <>
                      <Button
                        disabled={isPending}
                        onClick={session.handleDiscard}
                        size="sm"
                        variant="outline"
                      >
                        Discard
                      </Button>
                      <Button
                        disabled={isPending}
                        onClick={session.handlePublish}
                        size="sm"
                      >
                        {content.isSaving ? "Publishing..." : "Publish"}
                      </Button>
                    </>
                  ) : (
                    <Button
                      disabled={session.isViewingHistorical}
                      onClick={session.handleEdit}
                      size="sm"
                      variant="secondary"
                    >
                      Edit
                    </Button>
                  )}
                </>
              }
            />

            {/* Generation Status Banner */}
            <GenerationStatusBanner artifactId={prd.id} />

            {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: wraps TipTap rich text editor */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: wraps TipTap rich text editor */}
            <div
              className="flex min-h-0 flex-1 flex-col"
              onClick={
                session.isEditing || session.isViewingHistorical
                  ? undefined
                  : session.handleEdit
              }
              onKeyDown={
                session.isEditing || session.isViewingHistorical
                  ? undefined
                  : session.handleEdit
              }
            >
              <CollaborativeEditor
                contentResetKey={session.contentResetKey}
                contentResetValue={session.contentResetValue}
                key={session.latestVersion}
                liveblocksRoomId={session.liveblocksRoomId}
                onChange={content.updateContent}
                onEditorInstance={session.handleEditorInstance}
                onOpenThreadCountChange={session.handleThreadCountChange}
                readOnly={!session.isEditing}
                showComments={showComments}
                value={content.content}
              />
            </div>
          </OptionalArtifactRoom>
        </div>

        {/* Metadata Panel — spans full height from header down */}
        {uiState.showMetadataPanel ? (
          <PRDMetadataPanel
            approver={metadata.approver}
            assignee={metadata.assignee}
            onApproverSelect={metadata.handleApproverSelect}
            onAssigneeChange={metadata.handleAssigneeChange}
            onStatusChange={metadata.handleStatusChange}
            onTargetBranchBlur={metadata.handleTargetBranchBlur}
            onTargetBranchChange={metadata.handleTargetBranchChange}
            onTargetRepoBlur={metadata.handleTargetRepoBlur}
            onTargetRepoChange={metadata.handleTargetRepoChange}
            prd={prd}
            status={metadata.status}
            targetBranch={metadata.targetBranch}
            targetRepo={metadata.targetRepo}
            teamMembers={metadata.teamMembers}
          />
        ) : null}
      </div>

      {/* Rename Dialog */}
      <RenameDialog
        currentFileName={prd.fileName ?? ""}
        currentTitle={prd.title}
        description="Update the title and file name for this PRD."
        isPending={isPending}
        onOpenChange={setShowRenameDialog}
        onRename={actions.handleRename}
        open={showRenameDialog}
        title="Rename PRD"
      />

      {/* Move Dialog */}
      <MoveArtifactDialog
        artifact={prd}
        onOpenChange={setShowMoveDialog}
        open={showMoveDialog}
      />

      {/* Delete Confirmation Dialog */}
      <DeleteConfirmationDialog
        isPending={isPending}
        itemName={prd.title}
        onConfirm={actions.handleDelete}
        onOpenChange={uiState.setShowDeleteDialog}
        open={uiState.showDeleteDialog}
        title="PRD"
      />

      {/* Generate Implementation Plan Modal */}
      <NewPlanModal
        onOpenChange={setShowGeneratePlanModal}
        open={showGeneratePlanModal}
        source={newPlanSource}
      />
    </div>
  );
}
