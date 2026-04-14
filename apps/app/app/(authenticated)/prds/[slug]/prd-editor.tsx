"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import {
  type ArtifactDetail,
  ArtifactType,
} from "@repo/api/src/types/artifact";
import type { Priority } from "@repo/api/src/types/common";
import type { ComputeTargetConflictBody } from "@repo/api/src/types/compute-target";
import { EntityType } from "@repo/api/src/types/entity-link";
import { RunLoopCommand } from "@repo/api/src/types/loop";
import { InlinePresence, OptionalArtifactRoom } from "@repo/collaboration";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@repo/design-system/components/ui/resizable";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { TiptapToolbar } from "@repo/rich-text";
import { Loader2Icon } from "lucide-react";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { NewPlanModal } from "@/app/(authenticated)/implementation-plans/components/new-plan-modal";
import { VersionSelector } from "@/app/(authenticated)/implementation-plans/components/version-selector";
import { ArtifactChatPanel } from "@/components/artifact-editor/artifact-chat-panel";
import { CollaborativeEditor } from "@/components/artifact-editor/collaborative-editor";
import { EditableArtifactTitle } from "@/components/artifact-editor/editable-artifact-title";
import { EditorToolbarActions } from "@/components/artifact-editor/editor-toolbar-actions";
import { EditorToolbarRow } from "@/components/artifact-editor/editor-toolbar-row";
import { MetadataPanel } from "@/components/artifact-editor/metadata-panel";
import { StatusMetadataSection } from "@/components/artifact-editor/status-metadata-section";
import { TargetRepositoryFields } from "@/components/artifact-editor/target-repository-fields";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { LoopDispatchTargetSelector } from "@/components/engineer/LoopDispatchTargetSelector";
import { ExecutionLogDialog } from "@/components/execution-log/execution-log-dialog";
import { ExecutionLogSummary } from "@/components/execution-log/execution-log-summary";
import { GenerationStatusBanner } from "@/components/generation-status-banner";
import { MoveEntityDialog } from "@/components/move-entity-dialog";
import { RenameDialog } from "@/components/rename-dialog";
import { useArtifactActions } from "@/hooks/artifact-editing/use-artifact-actions";
import { useArtifactContent } from "@/hooks/artifact-editing/use-artifact-content";
import { useArtifactMetadata } from "@/hooks/artifact-editing/use-artifact-metadata";
import { useArtifactUIState } from "@/hooks/artifact-editing/use-artifact-ui-state";
import { useEditorSession } from "@/hooks/artifact-editing/use-editor-session";
import { usePrdActions } from "@/hooks/artifact-editing/use-prd-actions";
import {
  useArtifactGenerationStatus,
  useDismissArtifactGenerationStatus,
} from "@/hooks/queries/use-artifacts";
import { usePrdJudgesFeedback } from "@/hooks/queries/use-judges";
import { useRunLoop } from "@/hooks/queries/use-loops";
import { useExecutionLogDialog } from "@/hooks/use-execution-log-dialog";
import { parseComputeTargetConflict } from "@/lib/compute-target-conflict";
import { PRIORITY_LABELS } from "@/lib/project-constants";
import type { PlanSource } from "../../implementation-plans/components/plan-source";
import { RequestChangesModal } from "../../implementation-plans/components/request-changes-modal";
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
  const executionLogDialog = useExecutionLogDialog();

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
  const actions = useArtifactActions({
    artifact: prd,
    redirectPath: prd.project?.teams?.[0]?.id
      ? `/teams/${prd.project.teams[0].id}/projects/${prd.project.id}`
      : "/prds",
  });

  const uiState = useArtifactUIState({
    artifactType: ArtifactType.Prd,
  });

  const prdActions = usePrdActions({ artifactId: prd.id });

  // Type assertion: useArtifactUIState returns a union; narrow to the PRD/Feature branch
  const {
    showRenameDialog,
    setShowRenameDialog,
    openRenameDialog,
    showGeneratePlanModal,
    setShowGeneratePlanModal,
    openGeneratePlanModal,
    showRequestChangesModal,
    setShowRequestChangesModal,
    openRequestChangesModal,
  } = uiState;

  const [decomposeTargetState, setDecomposeTargetState] = useState<{
    availableTargets: ComputeTargetConflictBody["availableTargets"];
  } | null>(null);

  // Fetch generation status with adaptive polling (stops when terminal)
  const { data: generationStatus, invalidateCache: invalidateArtifactCache } =
    useArtifactGenerationStatus(prd.id, { polling: true });
  const dismissGenerationStatus = useDismissArtifactGenerationStatus();

  // Loop-based actions (PRD generation, decompose)
  const runLoop = useRunLoop();
  const { data: judgesReport } = usePrdJudgesFeedback(prd.id);

  const handleGeneratePrd = () => {
    runLoop.mutate(
      {
        artifactId: prd.id,
        command: RunLoopCommand.GeneratePrd,
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
      { artifactId: prd.id, command: "decompose" },
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
    // Omit computeTargetId so the API resolves the target from the user's saved
    // compute preference (same as explicit plan evaluation). Passing
    // routing.computeTargetId here could be null on hosted production when
    // Electron is not detected, which the API treated as an explicit cloud
    // override and skipped local preference resolution.
    runLoop.mutate(
      { artifactId: prd.id, command: RunLoopCommand.EvaluatePrd },
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
      onVersionChange={onVersionChange}
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
        isRequestingChanges={prdActions.isRequestingChanges}
        onDecomposeFeatures={handleDecomposeFeatures}
        onDelete={uiState.openDeleteDialog}
        onEvaluatePrd={handleEvaluatePrd}
        onExport={actions.handleDownload}
        onGeneratePlan={openGeneratePlanModal}
        onGeneratePrd={handleGeneratePrd}
        onMove={() => setShowMoveDialog(true)}
        onRename={openRenameDialog}
        onRequestChanges={openRequestChangesModal}
        onRestoreVersion={session.handleRestoreVersion}
        onToggleMetadataPanel={uiState.toggleMetadataPanel}
        prd={prd}
        showMetadataPanel={uiState.showMetadataPanel}
        showRestore={session.isViewingHistorical}
      />

      {/* Content area: main content + chat panel on right */}
      <ResizablePanelGroup autoSaveId="prd-editor" direction="horizontal">
        <ResizablePanel defaultSize={75} minSize={50}>
          <div className="h-full overflow-y-auto overflow-x-hidden bg-background">
            <OptionalArtifactRoom
              key={session.roomResetKey}
              roomId={session.liveblocksRoomId}
            >
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
                {/* Toolbar Row: formatting + version/save controls */}
                <EditorToolbarRow
                  leftContent={
                    <TiptapToolbar
                      className="border-0 bg-transparent p-0"
                      editor={session.editor}
                      hasLiveblocksExtension={!!session.liveblocksRoomId}
                    />
                  }
                  rightContent={
                    <>
                      {session.liveblocksRoomId && (
                        <Suspense fallback={null}>
                          <InlinePresence />
                        </Suspense>
                      )}
                      {versionDisplay}
                      <EditorToolbarActions
                        isPending={isPending}
                        isSaving={contentController.isSaving}
                        onRestoreVersion={session.handleDiscard}
                        onSaveVersion={session.handlePublish}
                        onToggleComments={setShowComments}
                        openThreadCount={session.openThreadCount}
                        showComments={showComments}
                        showRestoreVersion={prd.latestVersion > 1}
                      />
                    </>
                  }
                />

                {/* Generation Status Banner */}
                <GenerationStatusBanner
                  generationStatus={generationStatus}
                  isDismissFailurePending={dismissGenerationStatus.isPending}
                  onDismissFailure={async (runKey) => {
                    await dismissGenerationStatus.mutateAsync({
                      artifactId: prd.id,
                      runKey,
                    });
                  }}
                  onGenerationComplete={invalidateArtifactCache}
                />

                <div className="flex min-h-[200px] flex-col">
                  <CollaborativeEditor
                    contentResetKey={session.contentResetKey}
                    contentResetValue={session.contentResetValue}
                    externalToolbar
                    headerContent={
                      <div className="space-y-4 px-5 pt-10">
                        <EditableArtifactTitle
                          artifactId={prd.id}
                          initialTitle={prd.title}
                        />
                        <MetadataPanel variant="bar">
                          <StatusMetadataSection
                            assignee={metadata.assignee}
                            layout="horizontal"
                            onAssigneeChange={metadata.handleAssigneeChange}
                            onStatusChange={metadata.handleStatusChange}
                            status={metadata.status}
                            teamMembers={metadata.teamMembers}
                          />
                          <Select
                            onValueChange={(v) =>
                              metadata.handlePriorityChange(v as Priority)
                            }
                            value={metadata.priority}
                          >
                            <SelectTrigger
                              className="min-w-0 justify-start gap-1 bg-transparent dark:bg-transparent [&>:last-child]:hidden"
                              size="sm"
                            >
                              <SelectValue>
                                <span className="inline-flex items-center gap-1.5">
                                  <PriorityIcon priority={metadata.priority} />
                                  {PRIORITY_LABELS[metadata.priority]}
                                </span>
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              {Object.entries(PRIORITY_LABELS).map(
                                ([value, label]) => (
                                  <SelectItem key={value} value={value}>
                                    <span className="inline-flex items-center gap-1.5">
                                      <PriorityIcon
                                        priority={value as Priority}
                                      />
                                      {label}
                                    </span>
                                  </SelectItem>
                                )
                              )}
                            </SelectContent>
                          </Select>
                          <TargetRepositoryFields
                            layout="horizontal"
                            onTargetBranchBlur={metadata.handleTargetBranchBlur}
                            onTargetBranchChange={
                              metadata.handleTargetBranchChange
                            }
                            onTargetRepoBlur={metadata.handleTargetRepoBlur}
                            onTargetRepoChange={metadata.handleTargetRepoChange}
                            separator={false}
                            targetBranch={metadata.targetBranch}
                            targetRepo={metadata.targetRepo}
                            title=""
                          />
                        </MetadataPanel>
                      </div>
                    }
                    key={currentVersion}
                    liveblocksRoomId={session.liveblocksRoomId}
                    onChange={contentController.updateContent}
                    onContentReady={session.handleContentReady}
                    onEditorInstance={session.handleEditorInstance}
                    onOpenThreadCountChange={session.handleThreadCountChange}
                    placeholder="Add description..."
                    readOnly={session.isViewingHistorical}
                    showComments={showComments}
                    value={contentController.content}
                  />
                </div>

                {/* Details (execution log, evaluation, comments, attachments) */}
                <div className="border-t px-4 py-4">
                  <PRDMetadataPanel
                    judgeItems={judgesReport ?? null}
                    prd={prd}
                    variant="detailsOnly"
                  />
                </div>
              </div>
            </OptionalArtifactRoom>
          </div>
        </ResizablePanel>

        {/* Right panel: Chat + Execution Log tabs */}
        {chatFlag?.enabled !== false && uiState.showMetadataPanel && (
          <>
            <ResizableHandle className="after:!w-[3px] z-20 hover:after:bg-primary" />
            <ResizablePanel defaultSize={25} maxSize={40} minSize={15}>
              <Tabs className="flex h-full flex-col" defaultValue="chat">
                <TabsList className="mx-3 mt-3 w-auto">
                  <TabsTrigger value="chat">Chat</TabsTrigger>
                  <TabsTrigger value="execution-log">Execution Log</TabsTrigger>
                </TabsList>
                <TabsContent
                  className="min-h-0 flex-1 overflow-hidden"
                  value="chat"
                >
                  <ArtifactChatPanel artifactId={prd.id} artifactType="prd" />
                </TabsContent>
                <TabsContent
                  className="min-h-0 flex-1 overflow-y-auto p-4"
                  value="execution-log"
                >
                  <ExecutionLogSummary
                    artifactId={prd.id}
                    onViewFullTrace={executionLogDialog.handleViewFullTrace}
                  />
                </TabsContent>
              </Tabs>
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>

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

      {/* Execution Log Dialog */}
      <ExecutionLogDialog
        initialSessionId={executionLogDialog.selectedSessionId}
        onOpenChange={executionLogDialog.setDialogOpen}
        open={executionLogDialog.dialogOpen}
        trace={executionLogDialog.dialogTrace}
      />

      {/* Request Changes Modal */}
      <RequestChangesModal
        isSubmitting={prdActions.isRequestingChanges}
        onOpenChange={setShowRequestChangesModal}
        onSubmit={prdActions.handleRequestChanges}
        open={showRequestChangesModal}
      />

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
      <MoveEntityDialog
        entity={{
          id: prd.id,
          entityType: EntityType.Artifact,
          projectId: prd.projectId,
        }}
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
