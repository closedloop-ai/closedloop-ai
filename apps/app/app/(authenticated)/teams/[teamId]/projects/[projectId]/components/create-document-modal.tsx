"use client";

import type { ComputeTargetConflictBody } from "@repo/api/src/types/compute-target";
import {
  DOCUMENT_STATUS_OPTIONS,
  type Document,
  DocumentStatus,
  DocumentType,
  type DocumentWithWorkstream,
} from "@repo/api/src/types/document";
import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import { getProjectSettings } from "@repo/api/src/types/project";
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
import { AdditionalReposPicker } from "@/app/(authenticated)/implementation-plans/components/additional-repos-picker";
import { LoopDispatchTargetSelector } from "@/components/engineer/LoopDispatchTargetSelector";
import {
  HiddenFileInput,
  type HiddenFileInputHandle,
} from "@/components/hidden-file-input";
import {
  useCreateDocument,
  useDocumentsByProject,
  useGeneratePrdLaunch,
} from "@/hooks/queries/use-documents";
import {
  useGitHubBranches,
  useGitHubIntegrationStatus,
  useGitHubRepositories,
} from "@/hooks/queries/use-github-integration";
import { useProject, useProjectsByTeam } from "@/hooks/queries/use-projects";
import { useTeamMembers } from "@/hooks/queries/use-teams";
import { useMultiRepoPrdEnabled } from "@/hooks/use-multi-repo-prd-enabled";
import {
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_TYPE_BADGE_LABELS,
  DOCUMENT_TYPE_ICONS,
  DOCUMENT_TYPE_LABELS,
} from "@/lib/project-constants";
import {
  PreLoopCommand,
  type PreLoopExecutionContext,
} from "@/lib/system-check/pre-loop-health-check";
import { useOptionalPreLoopSystemCheckGate } from "@/lib/system-check/pre-loop-system-check-provider";
import { transformApiUserToSelectUser } from "@/lib/user-utils";

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
  const [status, setStatus] = useState<DocumentStatus>("DRAFT");
  const [targetRepo, setTargetRepo] = useState("");
  const [targetBranch, setTargetBranch] = useState("main");
  const [selectedRepoId, setSelectedRepoId] = useState<string>("");
  const [reverseSynthesisLink, setReverseSynthesisLink] = useState("");
  const [additionalRepos, setAdditionalRepos] = useState<AdditionalRepoRef[]>(
    []
  );
  const [incompleteAdditionalRepos, setIncompleteAdditionalRepos] =
    useState(false);

  // Context source selection for implementation plans (PRD or Feature)
  const [selectedSourceId, setSelectedSourceId] = useState<string>("");
  const [sourcePopoverOpen, setSourcePopoverOpen] = useState(false);

  // Seed the default GH repository from the project settings
  const { data: project } = useProject(selectedProjectId, {
    enabled: open && !!selectedProjectId,
  });
  const hasSeededRepoRef = useRef(false);
  if (project && !hasSeededRepoRef.current) {
    const projectSettings = getProjectSettings(project.settings);
    const defaultRepo = projectSettings.defaultRepository;
    if (defaultRepo) {
      setSelectedRepoId(defaultRepo.repoId);
      setTargetRepo(defaultRepo.repoFullName);
      setTargetBranch(defaultRepo.branch);
    }
    hasSeededRepoRef.current = true;
  }

  const typeLabel = DOCUMENT_TYPE_LABELS[documentType] ?? documentType;
  const isImplementationPlan = documentType === DocumentType.ImplementationPlan;
  const isPrd = documentType === DocumentType.Prd;
  const isMultiRepoPrdEnabled = useMultiRepoPrdEnabled();
  const showPicker = isPrd && isMultiRepoPrdEnabled;

  // GitHub integration queries
  const { data: githubStatus, isLoading: isLoadingGitHubStatus } =
    useGitHubIntegrationStatus();
  const { data: repositories, isLoading: isLoadingRepos } =
    useGitHubRepositories({
      enabled: githubStatus?.connected === true,
    });
  const { data: branchesData, isLoading: isLoadingBranches } =
    useGitHubBranches(selectedRepoId, {
      enabled: !!selectedRepoId,
    });

  const sortedRepositories = useMemo(
    () =>
      repositories
        ? [...repositories].sort((a, b) => a.name.localeCompare(b.name))
        : [],
    [repositories]
  );

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

  // Auto-select default branch only when no branch is selected yet
  useEffect(() => {
    if (branchesData?.branches && !targetBranch) {
      const defaultBranch = branchesData.branches.find((b) => b.isDefault);
      if (defaultBranch) {
        setTargetBranch(defaultBranch.name);
      }
    }
  }, [branchesData, targetBranch]);

  // Pre-populate fields from selected context source (PRD or Feature).
  useEffect(() => {
    if (!(isImplementationPlan && selectedSourceId)) {
      return;
    }

    const populatedFields = populateFieldsFromSource(
      selectedSourceId,
      contextSources,
      repositories,
      transformedUsers
    );

    applySourceFields(populatedFields, {
      setSelectedApprover,
      setStatus,
      setTargetRepo,
      setTargetBranch,
      setSelectedRepoId,
    });
  }, [
    isImplementationPlan,
    selectedSourceId,
    contextSources,
    repositories,
    transformedUsers,
  ]);

  const branchPlaceholder = getBranchPlaceholder(
    selectedRepoId,
    isLoadingBranches
  );

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
    hasSeededRepoRef.current = false;
  };

  const handleRepositoryChange = (repoId: string) => {
    const selectedRepo = repositories?.find((r) => r.id === repoId);
    if (selectedRepo) {
      setSelectedRepoId(repoId);
      setTargetRepo(selectedRepo.fullName);
      // Clear branch when repository changes - will be auto-set by useEffect
      setTargetBranch("");
    }
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
    setIncompleteAdditionalRepos(false);
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

    createDocument.mutate(
      {
        projectId: selectedProjectId,
        type: documentType,
        title: title.trim(),
        fileName: fileName.trim() || undefined,
        content: content.trim(),
        approverId: selectedApprover?.id ?? undefined,
        status,
        targetRepo: targetRepo.trim() || undefined,
        targetBranch: targetBranch.trim() || undefined,
        ...(isImplementationPlan &&
          selectedSourceId && {
            sourceId: selectedSourceId,
          }),
      },
      {
        onSuccess: (artifact) => {
          handleClose();
          onSuccess?.(artifact);
        },
      }
    );
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

    const createInput = {
      projectId: selectedProjectId,
      type: documentType,
      title: title.trim(),
      fileName: fileName.trim() || undefined,
      content: artifactContent,
      approverId: selectedApprover?.id ?? undefined,
      status,
      targetRepo: targetRepo.trim() || undefined,
      targetBranch: targetBranch.trim() || undefined,
    };
    const submitAdditionalRepos =
      showPicker && additionalRepos.length > 0 ? additionalRepos : undefined;
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
    setGeneratePrdMultiTargetState(null);
    generatePrdLaunch.mutate(
      {
        additionalRepos: pending.additionalRepos,
        artifact: pending.artifact,
        computeTargetId,
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

  const isSubmitting =
    createDocument.isPending ||
    generatePrdLaunch.isPending ||
    Boolean(preLoopGate?.pendingOwnerKey === preLoopOwnerKey);
  const isTargetSelectionPending = Boolean(generatePrdMultiTargetState);
  const canGenerate = computeCanGenerate(
    title,
    selectedProjectId,
    showPicker,
    incompleteAdditionalRepos
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
            <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-destructive text-sm">
              {error}
            </div>
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

          <RepositoryBranchFields
            branches={branchesData?.branches}
            branchPlaceholder={branchPlaceholder}
            githubConnected={githubStatus?.connected}
            isLoadingBranches={isLoadingBranches}
            isLoadingGitHubStatus={isLoadingGitHubStatus}
            isLoadingRepos={isLoadingRepos}
            onBranchChange={setTargetBranch}
            onRepositoryChange={handleRepositoryChange}
            selectedRepoId={selectedRepoId}
            sortedRepositories={sortedRepositories}
            targetBranch={targetBranch}
          />

          {showPicker && (
            <div className="space-y-2">
              <Label className="font-normal text-muted-foreground text-xs">
                Additional Repositories (optional)
              </Label>
              <AdditionalReposPicker
                initialValue={[]}
                onChange={setAdditionalRepos}
                onIncompleteChange={setIncompleteAdditionalRepos}
                targetRepo={targetRepo}
              />
            </div>
          )}

          <div className="space-y-2">
            <Label className="font-normal text-muted-foreground text-xs">
              Status
            </Label>
            <Select
              onValueChange={(v) => setStatus(v as DocumentStatus)}
              value={status}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DOCUMENT_STATUS_OPTIONS.map((statusOption) => (
                  <SelectItem key={statusOption} value={statusOption}>
                    {DOCUMENT_STATUS_LABELS[statusOption]}
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
  selectedSource: DocumentWithWorkstream | null;
  sources: DocumentWithWorkstream[];
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
        <Command>
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
  selectedSource: DocumentWithWorkstream | null;
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
  source: DocumentWithWorkstream;
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
  sources: DocumentWithWorkstream[],
  repositories: Array<{ id: string; fullName: string }> | undefined,
  transformedUsers: User[]
): {
  approver: User | null;
  status: DocumentStatus;
  targetRepo: string | null;
  targetBranch: string | null;
  selectedRepoId: string | null;
} | null {
  const selectedSource = sources.find((s) => s.id === sourceId);
  if (!selectedSource) {
    return null;
  }

  const matchingApprover = selectedSource.approver
    ? transformedUsers.find((u) => u.id === selectedSource.approver?.id)
    : null;

  // Only resolve selectedRepoId when the source has an explicit targetRepo.
  // A null return means "don't overwrite the caller's current value".
  let selectedRepoId: string | null = null;
  if (selectedSource.targetRepo && repositories) {
    const matchingRepo = repositories.find(
      (repo) => repo.fullName === selectedSource.targetRepo
    );
    if (matchingRepo) {
      selectedRepoId = matchingRepo.id;
    }
  }

  return {
    approver: matchingApprover || null,
    status: selectedSource.status ?? DocumentStatus.Draft,
    targetRepo: selectedSource.targetRepo ?? null,
    targetBranch: selectedSource.targetBranch ?? null,
    selectedRepoId,
  };
}

type SourceFieldSetters = {
  setSelectedApprover: (v: User | null) => void;
  setStatus: (v: DocumentStatus) => void;
  setTargetRepo: (v: string) => void;
  setTargetBranch: (v: string) => void;
  setSelectedRepoId: (v: string) => void;
};

/**
 * Applies the pre-populated source fields to form state.
 * Only overwrites repo/branch/repoId when the source explicitly defines them
 * (null means "don't overwrite the caller's current value").
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
  if (fields.targetRepo !== null) {
    setters.setTargetRepo(fields.targetRepo);
  }
  if (fields.targetBranch !== null) {
    setters.setTargetBranch(fields.targetBranch);
  }
  if (fields.selectedRepoId !== null) {
    setters.setSelectedRepoId(fields.selectedRepoId);
  }
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

function getBranchPlaceholder(
  selectedRepoId: string,
  isLoadingBranches: boolean
) {
  if (!selectedRepoId) {
    return "Select a repository first";
  }
  if (isLoadingBranches) {
    return "Loading branches...";
  }
  return "Select a branch";
}

function RepositoryBranchFields({
  githubConnected,
  isLoadingGitHubStatus,
  isLoadingRepos,
  isLoadingBranches,
  selectedRepoId,
  sortedRepositories,
  onRepositoryChange,
  targetBranch,
  onBranchChange,
  branches,
  branchPlaceholder,
}: Readonly<{
  githubConnected: boolean | undefined;
  isLoadingGitHubStatus: boolean;
  isLoadingRepos: boolean;
  isLoadingBranches: boolean;
  selectedRepoId: string;
  sortedRepositories: Array<{ id: string; fullName: string }>;
  onRepositoryChange: (repoId: string) => void;
  targetBranch: string;
  onBranchChange: (branch: string) => void;
  branches: Array<{ name: string; isDefault: boolean }> | undefined;
  branchPlaceholder: string;
}>) {
  return (
    <>
      <div className="space-y-2">
        <Label
          className="font-normal text-muted-foreground text-xs"
          htmlFor="artifact-target-repo"
        >
          Target Repository (for code generation)
        </Label>
        {githubConnected === false ? (
          <div className="rounded-md border border-muted bg-muted/20 p-3 text-muted-foreground text-sm">
            Connect GitHub to select a repository
          </div>
        ) : (
          <Select
            disabled={isLoadingGitHubStatus || isLoadingRepos}
            onValueChange={onRepositoryChange}
            value={selectedRepoId}
          >
            <SelectTrigger id="artifact-target-repo">
              <SelectValue
                placeholder={
                  isLoadingGitHubStatus || isLoadingRepos
                    ? "Loading repositories..."
                    : "Select a repository"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {sortedRepositories.map((repo) => (
                <SelectItem key={repo.id} value={repo.id}>
                  {repo.fullName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="space-y-2">
        <Label
          className="font-normal text-muted-foreground text-xs"
          htmlFor="artifact-target-branch"
        >
          Target Branch
        </Label>
        <Select
          disabled={!selectedRepoId || isLoadingBranches}
          onValueChange={onBranchChange}
          value={targetBranch}
        >
          <SelectTrigger id="artifact-target-branch">
            <SelectValue placeholder={branchPlaceholder} />
          </SelectTrigger>
          <SelectContent>
            {branches?.map((branch) => (
              <SelectItem key={branch.name} value={branch.name}>
                {branch.name}
                {branch.isDefault ? " (default)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
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
  showPicker: boolean,
  incompleteAdditionalRepos: boolean
): boolean {
  if (!title.trim()) {
    return false;
  }
  if (!selectedProjectId) {
    return false;
  }
  if (showPicker && incompleteAdditionalRepos) {
    return false;
  }
  return true;
}
