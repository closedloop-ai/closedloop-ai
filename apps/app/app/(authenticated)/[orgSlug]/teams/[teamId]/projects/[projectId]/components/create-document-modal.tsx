"use client";

import type { ComputeTargetConflictBody } from "@repo/api/src/types/compute-target";
import {
  type ArtifactStatus,
  type CreateDocumentInput,
  DOCUMENT_STATUS_OPTIONS,
  type Document,
  DocumentStatus,
  DocumentType,
  type DocumentWithProject,
  FEATURE_STATUS_OPTIONS,
  fallbackStatusForSubtype,
} from "@repo/api/src/types/document";
import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import {
  useCreateDocument,
  useDocumentsByProject,
} from "@repo/app/documents/hooks/use-documents";
import { useResolvedJobRepos } from "@repo/app/loops/hooks/use-resolved-job-repos";
import { useProjectsByTeam } from "@repo/app/projects/hooks/use-projects";
import {
  ARTIFACT_STATUS_LABELS,
  DOCUMENT_TYPE_BADGE_LABELS,
  DOCUMENT_TYPE_ICONS,
  DOCUMENT_TYPE_LABELS,
} from "@repo/app/projects/lib/project-constants";
import {
  HiddenFileInput,
  type HiddenFileInputHandle,
} from "@repo/app/shared/components/hidden-file-input";
import { transformApiUserToSelectUser } from "@repo/app/shared/lib/user-utils";
import { useTeamMembers } from "@repo/app/teams/hooks/use-teams";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@repo/design-system/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import {
  type User,
  UserSelectPopover,
} from "@repo/design-system/components/ui/user-select-popover";
import { cn } from "@repo/design-system/lib/utils";
import {
  CheckIcon,
  ChevronsUpDownIcon,
  LoaderIcon,
  SparklesIcon,
  UploadIcon,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { JobRepositoriesSection } from "@/app/(authenticated)/components/job-repositories-section";
import { LoopDispatchTargetSelector } from "@/components/engineer/LoopDispatchTargetSelector";
import { useGeneratePrdLaunch } from "@/hooks/queries/use-document-generation";
import {
  PreLoopCommand,
  type PreLoopExecutionContext,
} from "@/lib/system-check/pre-loop-health-check";
import { useOptionalPreLoopSystemCheckGate } from "@/lib/system-check/pre-loop-system-check-provider";

export type CreateDocumentModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  documentType: DocumentType;
  projectId?: string;
  teamId: string;
  onSuccess?: (artifact: Document) => void;
};

type GeneratePrdMultiTargetState = {
  additionalRepos?: AdditionalRepoRef[];
  artifact: Document;
  availableTargets: ComputeTargetConflictBody["availableTargets"];
};

export function CreateDocumentModal({
  open,
  onOpenChange,
  documentType,
  projectId,
  teamId,
  onSuccess,
}: Readonly<CreateDocumentModalProps>) {
  const fileInputRef = useRef<HiddenFileInputHandle>(null);
  const preLoopOwnerKey = `create-document:${useId()}`;
  const preLoopGate = useOptionalPreLoopSystemCheckGate();
  const [error, setError] = useState<string | null>(null);
  const [generatePrdMultiTargetState, setGeneratePrdMultiTargetState] =
    useState<GeneratePrdMultiTargetState | null>(null);

  // Project selection (when projectId prop is not provided)
  const showProjectSelector = !projectId;
  const [selectedProjectId, setSelectedProjectId] = useState(projectId ?? "");
  const { data: teamProjects = [], isLoading: isLoadingProjects } =
    useProjectsByTeam(teamId, { enabled: open && showProjectSelector });

  const [title, setTitle] = useState("");
  const [fileName, setFileName] = useState("");
  const [content, setContent] = useState("");

  // PRD-specific fields
  const [selectedApprover, setSelectedApprover] = useState<User | null>(null);
  // Default to the subtype-appropriate status (Features → BACKLOG). PRD-495.
  const [status, setStatus] = useState<ArtifactStatus>(() =>
    fallbackStatusForSubtype(documentType)
  );
  const [targetRepo, setTargetRepo] = useState("");
  const [targetBranch, setTargetBranch] = useState("");
  const [reverseSynthesisLink, setReverseSynthesisLink] = useState("");
  const [additionalRepos, setAdditionalRepos] = useState<AdditionalRepoRef[]>(
    []
  );

  // Context source selection for implementation plans (PRD or Feature)
  const [selectedSourceId, setSelectedSourceId] = useState<string>("");
  const [sourcePopoverOpen, setSourcePopoverOpen] = useState(false);

  const typeLabel = DOCUMENT_TYPE_LABELS[documentType] ?? documentType;
  const isImplementationPlan = documentType === DocumentType.ImplementationPlan;
  const isPrd = documentType === DocumentType.Prd;

  // JobRepositoriesSection owns repository selection for every flow (primary
  // plus additional repos), consuming the project resolver's `resolved`
  // payload.
  const resolvedJobRepos = useResolvedJobRepos({
    projectId: selectedProjectId,
    enabled: open && !!selectedProjectId,
  });
  const [jobRepoIncomplete, setJobRepoIncomplete] = useState(false);

  // Fetch project documents when modal opens for implementation plan
  const { data: artifacts = [], isLoading: loadingSources } =
    useDocumentsByProject(selectedProjectId, {
      enabled: open && isImplementationPlan && !!selectedProjectId,
    });

  // Filter to PRDs and Features — either can serve as an implementation plan's context.
  const contextSources = useMemo(
    () =>
      artifacts.filter(
        (a) => a.type === DocumentType.Prd || a.type === DocumentType.Feature
      ),
    [artifacts]
  );

  const selectedSource = useMemo(
    () => contextSources.find((s) => s.id === selectedSourceId) ?? null,
    [contextSources, selectedSourceId]
  );

  // Fetch team members for approver dropdown
  const { data: teamMembers = [], isLoading: isLoadingUsers } = useTeamMembers(
    teamId,
    { enabled: open }
  );
  const transformedUsers = useMemo(
    () => teamMembers.map((m) => transformApiUserToSelectUser(m.user)),
    [teamMembers]
  );

  // Create artifact mutations
  const createDocument = useCreateDocument();
  const generatePrdLaunch = useGeneratePrdLaunch();

  // Pre-populate fields from selected context source (PRD or Feature).
  useEffect(() => {
    if (!(isImplementationPlan && selectedSourceId)) {
      return;
    }

    const populatedFields = populateFieldsFromSource(
      selectedSourceId,
      contextSources,
      transformedUsers
    );

    applySourceFields(populatedFields, {
      setSelectedApprover,
      setStatus,
    });
  }, [
    isImplementationPlan,
    selectedSourceId,
    contextSources,
    transformedUsers,
  ]);

  const handleTitleChange = (value: string) => {
    setTitle(value);
    // Auto-generate filename from title
    if (value.trim()) {
      const generatedFileName = value
        .toLowerCase()
        .replaceAll(/[^a-z0-9\s]/g, "")
        .replaceAll(/\s+/g, "-")
        .concat(".md");
      setFileName(generatedFileName);
    }
  };

  const handleProjectChange = (newProjectId: string) => {
    setSelectedProjectId(newProjectId);
    // Clear project-scoped state so stale selections don't carry over
    setSelectedSourceId("");
  };

  const resetForm = () => {
    setTitle("");
    setFileName("");
    setContent("");
    setSelectedApprover(null);
    setStatus("DRAFT");
    setSelectedSourceId("");
    setReverseSynthesisLink("");
    setAdditionalRepos([]);
    setGeneratePrdMultiTargetState(null);
    setError(null);
    fileInputRef.current?.reset();
    if (showProjectSelector) {
      setSelectedProjectId("");
    }
  };

  const handleClose = () => {
    preLoopGate?.cancelPendingPreLoopAttempt(preLoopOwnerKey);
    onOpenChange(false);
    resetForm();
  };

  const handleFileRead = (content: string) => {
    if (!content.trim()) {
      setError("File is empty");
      return;
    }
    setContent(content);
  };

  const handleSubmit = () => {
    setError(null);
    if (!selectedProjectId) {
      setError("Please select a project");
      return;
    }
    if (!title.trim()) {
      setError("Please enter a title");
      return;
    }

    const submitAdditionalRepos =
      additionalRepos.length > 0 ? additionalRepos : undefined;
    const createInput = buildModalCreateInput({
      projectId: selectedProjectId,
      documentType,
      title,
      fileName,
      content: content.trim(),
      approverId: selectedApprover?.id ?? undefined,
      status,
      targetRepo,
      targetBranch,
      additionalRepos: submitAdditionalRepos,
      sourceId:
        isImplementationPlan && selectedSourceId ? selectedSourceId : undefined,
    });
    createDocument.mutate(createInput, {
      onSuccess: (artifact) => {
        handleClose();
        onSuccess?.(artifact);
      },
    });
  };

  const handleGenerate = () => {
    setError(null);
    if (!selectedProjectId) {
      setError("Please select a project");
      return;
    }
    if (!title.trim()) {
      setError("Please enter a title");
      return;
    }
    if (!targetRepo.trim()) {
      setError("Please select a target repository for PRD generation");
      return;
    }

    // Persist user content + source URL on the artifact itself.
    // The context pack delivers artifact content to the agent as the
    // primary artifact, so we do NOT send it as `prompt` (which would
    // override GENERATE_PRD_INSTRUCTIONS).
    const artifactContent = reverseSynthesisLink.trim()
      ? `${content.trim()}\n\nSource URL for reference: ${reverseSynthesisLink.trim()}`
      : content.trim();

    // The repositorySnapshot stored on the document is server-owned (PLN-602),
    // but we send the user's explicit modal selection as `repositorySelection`
    // so the server builds a `loop_selection` snapshot that includes the
    // additional repos. Without this the snapshot falls through to project
    // defaults, which often only contain the primary.
    const submitAdditionalRepos =
      additionalRepos.length > 0 ? additionalRepos : undefined;
    const createInput = buildModalCreateInput({
      projectId: selectedProjectId,
      documentType,
      title,
      fileName,
      content: artifactContent,
      approverId: selectedApprover?.id ?? undefined,
      status,
      targetRepo,
      targetBranch,
      additionalRepos: submitAdditionalRepos,
    });
    const executeGeneratePrd = (context: PreLoopExecutionContext) => {
      createDocument.mutate(createInput, {
        onSuccess: (artifact) => {
          generatePrdLaunch.mutate(
            {
              artifact,
              additionalRepos: submitAdditionalRepos,
              computeTargetId: context.computeTargetId,
            },
            {
              onSuccess: (result) => {
                if (result.status === "pending_target_selection") {
                  setGeneratePrdMultiTargetState({
                    additionalRepos: result.additionalRepos,
                    artifact: result.artifact,
                    availableTargets: result.availableTargets,
                  });
                  return;
                }
                handleClose();
                onSuccess?.(result.artifact);
              },
            }
          );
        },
      });
    };

    if (preLoopGate) {
      preLoopGate
        .runWithPreLoopSystemCheck(
          {
            command: PreLoopCommand.GeneratePrd,
            documentType: "prd",
            ownerKey: preLoopOwnerKey,
          },
          executeGeneratePrd
        )
        .catch(() => undefined);
      return;
    }

    executeGeneratePrd({});
  };

  const handleGenerateTargetSelect = (computeTargetId: string) => {
    if (!generatePrdMultiTargetState) {
      return;
    }
    const pending = generatePrdMultiTargetState;
    const executeGeneratePrd = (context: PreLoopExecutionContext) => {
      generatePrdLaunch.mutate(
        {
          additionalRepos: pending.additionalRepos,
          artifact: pending.artifact,
          computeTargetId: context.computeTargetId ?? computeTargetId,
        },
        {
          onSuccess: (result) => {
            if (result.status === "pending_target_selection") {
              setGeneratePrdMultiTargetState({
                additionalRepos: result.additionalRepos,
                artifact: result.artifact,
                availableTargets: result.availableTargets,
              });
              return;
            }
            handleClose();
            onSuccess?.(result.artifact);
          },
        }
      );
    };

    if (preLoopGate) {
      preLoopGate
        .runWithPreLoopSystemCheck(
          {
            command: PreLoopCommand.GeneratePrd,
            computeTargetId,
            documentType: "prd",
            ownerKey: preLoopOwnerKey,
          },
          executeGeneratePrd
        )
        .catch(() => undefined);
      return;
    }

    executeGeneratePrd({ computeTargetId });
  };

  const isSubmitting =
    createDocument.isPending ||
    generatePrdLaunch.isPending ||
    Boolean(preLoopGate?.pendingOwnerKey === preLoopOwnerKey);
  const isTargetSelectionPending = Boolean(generatePrdMultiTargetState);
  const canGenerate = computeCanGenerate(
    title,
    selectedProjectId,
    jobRepoIncomplete
  );

  return (
    <Dialog
      onOpenChange={(newOpen) => {
        if (newOpen) {
          onOpenChange(true);
        } else {
          handleClose();
        }
      }}
      open={open}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Create {typeLabel}</DialogTitle>
          <DialogDescription className="sr-only">
            Create a new {typeLabel.toLowerCase()} for this project.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-6">
          <GeneratePrdTargetSelector
            onSelect={handleGenerateTargetSelect}
            state={generatePrdMultiTargetState}
          />

          {error ? (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {showProjectSelector ? (
            <div className="space-y-2">
              <Label
                className="font-normal text-muted-foreground text-xs"
                htmlFor="artifact-project"
              >
                Project<span className="text-destructive">*</span>
              </Label>
              <Select
                disabled={isLoadingProjects}
                onValueChange={handleProjectChange}
                value={selectedProjectId}
              >
                <SelectTrigger id="artifact-project">
                  <SelectValue
                    placeholder={
                      isLoadingProjects
                        ? "Loading projects..."
                        : "Select a project..."
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {teamProjects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {isImplementationPlan ? (
            <div className="space-y-2">
              <Label
                className="font-normal text-muted-foreground text-xs"
                htmlFor="context-source"
              >
                Context Source (optional)
              </Label>
              <ContextSourceCombobox
                loading={loadingSources}
                onOpenChange={setSourcePopoverOpen}
                onSelect={setSelectedSourceId}
                open={sourcePopoverOpen}
                selectedSource={selectedSource}
                sources={contextSources}
              />
              <p className="text-muted-foreground text-xs">
                The implementation plan will be generated from this document.
              </p>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label
              className="font-normal text-muted-foreground text-xs"
              htmlFor="artifact-title"
            >
              Title<span className="text-destructive">*</span>
            </Label>
            <Input
              id="artifact-title"
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder={`Enter ${typeLabel.toLowerCase()} title`}
              value={title}
            />
          </div>

          <div className="space-y-2">
            <Label
              className="font-normal text-muted-foreground text-xs"
              htmlFor="artifact-filename"
            >
              File name
            </Label>
            <Input
              id="artifact-filename"
              onChange={(e) => setFileName(e.target.value)}
              placeholder="auto-generated-from-title.md"
              value={fileName}
            />
          </div>

          <div className="space-y-2">
            <Label className="font-normal text-muted-foreground text-xs">
              Approver
            </Label>
            <UserSelectPopover
              className="w-full"
              disabled={isLoadingUsers}
              onSelect={setSelectedApprover}
              placeholder={
                isLoadingUsers ? "Loading users..." : "Select approver..."
              }
              users={transformedUsers}
              value={selectedApprover}
            />
          </div>

          <JobRepositoriesSection
            collapseWhenSingleRepo={false}
            onChange={(selection) => {
              if (selection) {
                setTargetRepo(selection.primary.fullName);
                setTargetBranch(selection.primary.branch);
                setAdditionalRepos(selection.additional);
              }
            }}
            onIncompleteChange={setJobRepoIncomplete}
            requirePrimary={isPrd}
            resolved={resolvedJobRepos}
          />

          <div className="space-y-2">
            <Label className="font-normal text-muted-foreground text-xs">
              Status
            </Label>
            <Select
              onValueChange={(v) => setStatus(v as ArtifactStatus)}
              value={status}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(documentType === DocumentType.Feature
                  ? FEATURE_STATUS_OPTIONS
                  : DOCUMENT_STATUS_OPTIONS
                ).map((statusOption) => (
                  <SelectItem key={statusOption} value={statusOption}>
                    {ARTIFACT_STATUS_LABELS[statusOption]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isPrd && (
            <PrdContentFields
              content={content}
              fileInputRef={fileInputRef}
              onContentChange={setContent}
              onError={setError}
              onFileRead={handleFileRead}
              onReverseSynthesisLinkChange={setReverseSynthesisLink}
              reverseSynthesisLink={reverseSynthesisLink}
            />
          )}
        </div>

        <CreateDocumentFooter
          canGenerate={canGenerate}
          canSubmit={!!title.trim() && !!selectedProjectId}
          isGenerating={false}
          isPrd={isPrd}
          isSaving={createDocument.isPending}
          isSubmitting={isSubmitting}
          isTargetSelectionPending={isTargetSelectionPending}
          onCancel={handleClose}
          onGenerate={handleGenerate}
          onSubmit={handleSubmit}
          typeLabel={typeLabel}
        />
      </DialogContent>
    </Dialog>
  );
}

function GeneratePrdTargetSelector({
  onSelect,
  state,
}: Readonly<{
  onSelect: (targetId: string) => void;
  state: GeneratePrdMultiTargetState | null;
}>) {
  if (!state) {
    return null;
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 p-3">
      <p className="text-muted-foreground text-sm">
        Select a compute target to start generation.
      </p>
      <LoopDispatchTargetSelector
        availableTargets={state.availableTargets}
        onSelect={onSelect}
      />
    </div>
  );
}

type ContextSourceComboboxProps = {
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
  open: boolean;
  selectedSource: DocumentWithProject | null;
  sources: DocumentWithProject[];
};

function ContextSourceCombobox({
  loading,
  onOpenChange,
  onSelect,
  open,
  selectedSource,
  sources,
}: Readonly<ContextSourceComboboxProps>) {
  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          className="w-full justify-between font-normal"
          id="context-source"
          role="combobox"
          type="button"
          variant="outline"
        >
          <ContextSourceTriggerLabel
            loading={loading}
            selectedSource={selectedSource}
          />
          <ChevronsUpDownIcon className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[--radix-popover-trigger-width] p-0"
      >
        <Command label="Search PRDs and features">
          <CommandInput placeholder="Search PRDs and features..." />
          <CommandList>
            <CommandEmpty>
              {loading
                ? "Loading…"
                : "No PRDs or features in this project yet."}
            </CommandEmpty>
            <CommandGroup>
              {sources.map((source) => (
                <ContextSourceItem
                  key={source.id}
                  onSelect={(id) => {
                    onSelect(id);
                    onOpenChange(false);
                  }}
                  selected={selectedSource?.id === source.id}
                  source={source}
                />
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ContextSourceTriggerLabel({
  loading,
  selectedSource,
}: Readonly<{
  loading: boolean;
  selectedSource: DocumentWithProject | null;
}>) {
  if (selectedSource) {
    const Icon = DOCUMENT_TYPE_ICONS[selectedSource.type];
    return (
      <span className="flex min-w-0 items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{selectedSource.title}</span>
      </span>
    );
  }
  return (
    <span className="text-muted-foreground">
      {loading ? "Loading…" : "Select a PRD or feature…"}
    </span>
  );
}

function ContextSourceItem({
  onSelect,
  selected,
  source,
}: Readonly<{
  onSelect: (id: string) => void;
  selected: boolean;
  source: DocumentWithProject;
}>) {
  const Icon = DOCUMENT_TYPE_ICONS[source.type];
  const badgeLabel = DOCUMENT_TYPE_BADGE_LABELS[source.type];
  return (
    <CommandItem
      onSelect={() => onSelect(source.id)}
      value={`${source.title} ${badgeLabel} ${source.slug ?? ""}`}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-[44px] shrink-0 font-medium text-muted-foreground text-xs">
        {badgeLabel}
      </span>
      <span className="truncate">{source.title}</span>
      <CheckIcon
        className={cn(
          "ml-auto h-4 w-4",
          selected ? "opacity-100" : "opacity-0"
        )}
      />
    </CommandItem>
  );
}

/**
 * Pre-populates form fields from a selected context source document.
 * Returns updated field values or null if the source is not found.
 */
function populateFieldsFromSource(
  sourceId: string,
  sources: DocumentWithProject[],
  transformedUsers: User[]
): {
  approver: User | null;
  status: ArtifactStatus;
} | null {
  const selectedSource = sources.find((s) => s.id === sourceId);
  if (!selectedSource) {
    return null;
  }

  const matchingApprover = selectedSource.approver
    ? transformedUsers.find((u) => u.id === selectedSource.approver?.id)
    : null;

  return {
    approver: matchingApprover || null,
    status: selectedSource.status ?? DocumentStatus.Draft,
  };
}

type SourceFieldSetters = {
  setSelectedApprover: (v: User | null) => void;
  setStatus: (v: ArtifactStatus) => void;
};

/**
 * Applies the pre-populated source fields to form state.
 */
function applySourceFields(
  fields: ReturnType<typeof populateFieldsFromSource>,
  setters: SourceFieldSetters
) {
  if (!fields) {
    return;
  }
  setters.setSelectedApprover(fields.approver);
  setters.setStatus(fields.status);
}

function CreateDocumentFooter({
  isPrd,
  isSubmitting,
  isSaving,
  isGenerating,
  isTargetSelectionPending,
  canSubmit,
  canGenerate,
  typeLabel,
  onSubmit,
  onGenerate,
  onCancel,
}: Readonly<{
  isPrd: boolean;
  isSubmitting: boolean;
  isSaving: boolean;
  isGenerating: boolean;
  isTargetSelectionPending: boolean;
  canSubmit: boolean;
  canGenerate: boolean;
  typeLabel: string;
  onSubmit: () => void;
  onGenerate: () => void;
  onCancel: () => void;
}>) {
  return (
    <DialogFooter>
      <Button onClick={onCancel} type="button" variant="outline">
        Cancel
      </Button>
      {isPrd ? (
        <>
          <Button
            disabled={isSubmitting || !canSubmit}
            onClick={onSubmit}
            variant="outline"
          >
            {isSaving ? (
              <>
                <LoaderIcon className="h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save"
            )}
          </Button>
          <Button
            disabled={isSubmitting || isTargetSelectionPending || !canGenerate}
            onClick={onGenerate}
          >
            {isGenerating ? (
              <>
                <LoaderIcon className="h-4 w-4 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <SparklesIcon className="h-4 w-4" />
                Generate PRD
              </>
            )}
          </Button>
        </>
      ) : (
        <Button disabled={isSubmitting || !canSubmit} onClick={onSubmit}>
          {isSaving ? (
            <>
              <LoaderIcon className="h-4 w-4 animate-spin" />
              Creating...
            </>
          ) : (
            `Create ${typeLabel}`
          )}
        </Button>
      )}
    </DialogFooter>
  );
}

function PrdContentFields({
  content,
  onContentChange,
  fileInputRef,
  onError,
  onFileRead,
  reverseSynthesisLink,
  onReverseSynthesisLinkChange,
}: Readonly<{
  content: string;
  onContentChange: (value: string) => void;
  fileInputRef: React.RefObject<HiddenFileInputHandle | null>;
  onError: (error: string) => void;
  onFileRead: (content: string) => void;
  reverseSynthesisLink: string;
  onReverseSynthesisLinkChange: (value: string) => void;
}>) {
  return (
    <>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label
            className="font-normal text-muted-foreground text-xs"
            htmlFor="artifact-content"
          >
            Content (optional)
          </Label>
          <Button
            onClick={() => fileInputRef.current?.open()}
            size="sm"
            type="button"
            variant="outline"
          >
            <UploadIcon className="h-4 w-4" />
            Upload .md
          </Button>
        </div>
        <HiddenFileInput
          accept=".md"
          aria-label="Upload markdown file for artifact content"
          onError={onError}
          onFileRead={onFileRead}
          ref={fileInputRef}
        />
        <Textarea
          className="min-h-[120px] font-mono text-sm"
          id="artifact-content"
          onChange={(e) => onContentChange(e.target.value)}
          placeholder="Paste or upload markdown content to create a PRD, or enter a prompt to generate a PRD using AI..."
          value={content}
        />
      </div>

      <div className="space-y-2">
        <Label
          className="font-normal text-muted-foreground text-xs"
          htmlFor="reverse-synthesis-url"
        >
          Source URL (optional)
        </Label>
        <Input
          id="reverse-synthesis-url"
          onChange={(e) => onReverseSynthesisLinkChange(e.target.value)}
          placeholder="https://github.com/org/repo or documentation URL"
          value={reverseSynthesisLink}
        />
        <p className="text-muted-foreground text-xs">
          Provide a URL for the AI to reference when generating the PRD.
        </p>
      </div>
    </>
  );
}

function computeCanGenerate(
  title: string,
  selectedProjectId: string,
  jobRepoIncomplete: boolean
): boolean {
  if (!title.trim()) {
    return false;
  }
  if (!selectedProjectId) {
    return false;
  }
  if (jobRepoIncomplete) {
    return false;
  }
  return true;
}

function buildModalCreateInput(args: {
  projectId: string;
  documentType: DocumentType;
  title: string;
  fileName: string;
  content: string;
  approverId: string | undefined;
  status: ArtifactStatus;
  targetRepo: string;
  targetBranch: string;
  additionalRepos: AdditionalRepoRef[] | undefined;
  sourceId?: string;
}): CreateDocumentInput {
  const {
    projectId,
    documentType,
    title,
    fileName,
    content,
    approverId,
    status,
    targetRepo,
    targetBranch,
    additionalRepos,
    sourceId,
  } = args;
  const trimmedRepo = targetRepo.trim();
  const trimmedBranch = targetBranch.trim();
  const repositorySelection = trimmedRepo
    ? {
        primary: {
          fullName: trimmedRepo,
          ...(trimmedBranch ? { branch: trimmedBranch } : {}),
        },
        ...(additionalRepos ? { additional: additionalRepos } : {}),
      }
    : undefined;
  return {
    projectId,
    type: documentType,
    title: title.trim(),
    fileName: fileName.trim() || undefined,
    content,
    approverId,
    status,
    ...(sourceId ? { sourceId } : {}),
    ...(repositorySelection ? { repositorySelection } : {}),
  };
}
