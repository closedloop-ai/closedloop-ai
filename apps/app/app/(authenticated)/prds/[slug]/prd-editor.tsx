"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import {
  type ArtifactDetail,
  ArtifactType,
} from "@repo/api/src/types/artifact";
import type { ComputeTargetConflictBody } from "@repo/api/src/types/compute-target";
import { EntityType } from "@repo/api/src/types/entity-link";
import { RunLoopCommand } from "@repo/api/src/types/loop";
import { InlinePresence, OptionalArtifactRoom } from "@repo/collaboration";
import { toast } from "@repo/design-system/components/ui/sonner";
import { Loader2Icon } from "lucide-react";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { NewPlanModal } from "@/app/(authenticated)/implementation-plans/components/new-plan-modal";
import { VersionSelector } from "@/app/(authenticated)/implementation-plans/components/version-selector";
import { ArtifactChatPanel } from "@/components/artifact-editor/artifact-chat-panel";
import { CollaborativeEditor } from "@/components/artifact-editor/collaborative-editor";
import { EditorToolbarActions } from "@/components/artifact-editor/editor-toolbar-actions";
import { EditorToolbarRow } from "@/components/artifact-editor/editor-toolbar-row";
import { MetadataPanel } from "@/components/artifact-editor/metadata-panel";
import { SaveIndicator } from "@/components/artifact-editor/save-indicator";
import { StatusMetadataSection } from "@/components/artifact-editor/status-metadata-section";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { LoopDispatchTargetSelector } from "@/components/engineer/LoopDispatchTargetSelector";
import { GenerationStatusBanner } from "@/components/generation-status-banner";
import { MoveArtifactDialog } from "@/components/move-artifact-dialog";
import { RenameDialog } from "@/components/rename-dialog";
import { useArtifactActions } from "@/hooks/artifact-editing/use-artifact-actions";
import { useArtifactContent } from "@/hooks/artifact-editing/use-artifact-content";
import { useArtifactMetadata } from "@/hooks/artifact-editing/use-artifact-metadata";
import { useArtifactUIState } from "@/hooks/artifact-editing/use-artifact-ui-state";
import { useEditorSession } from "@/hooks/artifact-editing/use-editor-session";
import { usePrdJudgesFeedback } from "@/hooks/queries/use-judges";
import { useRunLoop } from "@/hooks/queries/use-loops";
import { useOrganizationUsers } from "@/hooks/queries/use-users";
import { parseComputeTargetConflict } from "@/lib/compute-target-conflict";
import { useEngineerRoutingSelection } from "@/lib/engineer/routing-store";
import { transformApiUserToSelectUser } from "@/lib/user-utils";
import type { PlanSource } from "../../implementation-plans/components/plan-source";
import { PRDEditorHeader } from "./components/prd-editor-header";
import { PRDMetadataPanel } from "./components/prd-metadata-panel";

type PRDEditorProps = {
  prd: ArtifactDetail;
  currentVersion: number;
  onVersionChange: (version: number) => void;
};

export function PRDEditor({
  prd,
  currentVersion,
  onVersionChange,
}: Readonly<PRDEditorProps>) {
  const chatFlag = useFeatureFlag("the-one-flag");

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

  const contentController = useArtifactContent({
    artifact: prd,
    onVersionCreated: () => {
      if (currentVersion !== prd.latestVersion) {
        onVersionChange(prd.latestVersion);
      }
    },
  });

  const session = useEditorSession({
    artifact: prd,
    currentVersion,
    contentCallbacks: contentController,
    onVersionChange,
  });
  const prevThreadCount = useRef(session.openThreadCount);

  const metadata = useArtifactMetadata({
    artifact: prd,
  });
  const { data: orgUsers = [] } = useOrganizationUsers();
  const transformedOrgUsers = useMemo(
    () => orgUsers.map(transformApiUserToSelectUser),
    [orgUsers]
  );

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

  const [decomposeTargetState, setDecomposeTargetState] = useState<{
    availableTargets: ComputeTargetConflictBody["availableTargets"];
  } | null>(null);

  // Loop-based actions (PRD generation, decompose)
  const runLoop = useRunLoop();
  const { data: judgesReport } = usePrdJudgesFeedback(prd.id);
  const routing = useEngineerRoutingSelection();
  // Pass computeTargetId for both CloudRelay and LocalElectron modes.
  // Loop dispatch always goes through the API → desktop gateway, which needs
  // the compute target ID regardless of how the engineer dashboard proxies.
  const computeTargetId = routing.computeTargetId;

  const handleGeneratePrd = () => {
    runLoop.mutate(
      {
        artifactId: prd.id,
        command: RunLoopCommand.GeneratePrd,
        computeTargetId,
      },
      {
        onSuccess: () => {
          toast.success("PRD generation started");
        },
      }
    );
  };

  const [pendingCommand, setPendingCommand] = useState<string | null>(null);

  const handleDecomposeFeatures = () => {
    setPendingCommand("decompose");
    runLoop.mutate(
      { artifactId: prd.id, command: "decompose", computeTargetId },
      {
        onSuccess: () => {
          toast.success("Feature decomposition started");
          setPendingCommand(null);
        },
        onError: (error) => {
          setPendingCommand(null);
          const conflict = parseComputeTargetConflict(error);
          if (conflict) {
            setDecomposeTargetState({
              availableTargets: conflict.availableTargets,
            });
          }
        },
      }
    );
  };

  const handleEvaluatePrd = () => {
    setPendingCommand("evaluate_prd");
    runLoop.mutate(
      { artifactId: prd.id, command: "evaluate_prd", computeTargetId },
      {
        onSuccess: () => {
          toast.success("PRD evaluation started");
          setPendingCommand(null);
        },
        onError: () => {
          setPendingCommand(null);
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
    contentController.isSaving ||
    metadata.isUpdating ||
    actions.isDeleting ||
    actions.isRenaming;

  // Create version display component for header
  const versionDisplay = (
    <VersionSelector
      currentVersion={currentVersion}
      latestVersion={prd.latestVersion}
      onVersionChange={(version) => {
        session.exitEditMode();
        onVersionChange(version);
      }}
    />
  );

  return (
    <>
      {/* Header */}
      <PRDEditorHeader
        canShowPanel={chatFlag?.enabled}
        isEvaluating={pendingCommand === "evaluate_prd"}
        isGenerating={runLoop.isPending}
        isPending={isPending}
        onDecomposeFeatures={handleDecomposeFeatures}
        onDelete={uiState.openDeleteDialog}
        onEvaluatePrd={handleEvaluatePrd}
        onExport={actions.handleDownload}
        onGeneratePlan={openGeneratePlanModal}
        onGeneratePrd={handleGeneratePrd}
        onMove={() => setShowMoveDialog(true)}
        onRename={openRenameDialog}
        onRestoreVersion={session.handleRestoreVersion}
        onToggleMetadataPanel={uiState.toggleMetadataPanel}
        prd={prd}
        showMetadataPanel={uiState.showMetadataPanel}
        showRestore={session.isViewingHistorical}
      />

      {/* Metadata bar below header */}
      <MetadataPanel className="pl-4" variant="bar">
        <StatusMetadataSection
          approver={metadata.approver}
          assignee={metadata.assignee}
          layout="horizontal"
          onApproverSelect={metadata.handleApproverSelect}
          onAssigneeChange={metadata.handleAssigneeChange}
          onStatusChange={metadata.handleStatusChange}
          orgUsers={transformedOrgUsers}
          status={metadata.status}
          teamMembers={metadata.teamMembers}
        />
      </MetadataPanel>

      {/* Content area: main content + chat panel on right */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden bg-background">
          <OptionalArtifactRoom roomId={session.liveblocksRoomId}>
            {/* Loading spinner — visible until editor content is fully loaded */}
            <div
              className={
                session.isContentReady
                  ? "hidden"
                  : "flex flex-1 items-center justify-center py-24"
              }
            >
              <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>

            {/* Content wrapper — hidden until Liveblocks Y.Doc sync completes */}
            <div
              className={
                session.isContentReady
                  ? undefined
                  : "invisible h-0 overflow-hidden"
              }
            >
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
                      isSaving={contentController.isSaving}
                      lastSaved={contentController.lastSaved}
                    />
                  </>
                }
                rightContent={
                  <EditorToolbarActions
                    isEditing={session.isEditing}
                    isPending={isPending}
                    isSaving={contentController.isSaving}
                    isViewingHistorical={session.isViewingHistorical}
                    onDiscard={session.handleDiscard}
                    onEdit={session.handleEdit}
                    onPublish={session.handlePublish}
                    onToggleComments={setShowComments}
                    openThreadCount={session.openThreadCount}
                    showComments={showComments}
                  />
                }
              />

              {/* Generation Status Banner */}
              <GenerationStatusBanner artifactId={prd.id} />

              {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: wraps TipTap rich text editor */}
              {/* biome-ignore lint/a11y/noStaticElementInteractions: wraps TipTap rich text editor */}
              <div
                className="flex min-h-[200px] flex-col"
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
                  key={currentVersion}
                  liveblocksRoomId={session.liveblocksRoomId}
                  onChange={contentController.updateContent}
                  onContentReady={session.handleContentReady}
                  onEditorInstance={session.handleEditorInstance}
                  onOpenThreadCountChange={session.handleThreadCountChange}
                  readOnly={!session.isEditing}
                  showComments={showComments}
                  value={contentController.content}
                />
              </div>

              {/* Details (target repo, version, execution log, comments, attachments) */}
              <div className="border-t px-4 py-4">
                <PRDMetadataPanel
                  approver={metadata.approver}
                  assignee={metadata.assignee}
                  judgeItems={judgesReport ?? null}
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
                  variant="detailsOnly"
                />
              </div>
            </div>
          </OptionalArtifactRoom>
        </div>

        {/* Chat panel (replaces metadata sidebar) */}
        {chatFlag?.enabled !== false && uiState.showMetadataPanel && (
          <ArtifactChatPanel artifactId={prd.id} artifactType="prd" />
        )}
      </div>

      {/* Compute target selector for decompose command */}
      {decomposeTargetState && (
        <LoopDispatchTargetSelector
          availableTargets={decomposeTargetState.availableTargets}
          onSelect={(targetId) => {
            setDecomposeTargetState(null);
            runLoop.mutate({
              artifactId: prd.id,
              command: "decompose",
              computeTargetId: targetId,
            });
          }}
        />
      )}

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
    </>
  );
}
