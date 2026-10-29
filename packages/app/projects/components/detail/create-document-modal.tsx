"use client";

import type { AdditionalRepoRef } from "@closedloop-ai/loops-api/context-pack";
import {
  type ArtifactStatus,
  type CreateDocumentInput,
  DOCUMENT_STATUS_OPTIONS,
  type Document,
  DocumentStatus,
  DocumentType,
  type DocumentWithProject,
  fallbackStatusForSubtype,
  ISSUE_STATUS_OPTIONS,
} from "@repo/api/src/types/document";
import { useResolvedJobRepos } from "@repo/app/documents/editors/shared/job-repositories/use-resolved-job-repos";
import { JobRepositoriesSection } from "@repo/app/documents/editors/shared/job-repositories-section";
import {
  useCreateDocument,
  useDocumentsByProject,
} from "@repo/app/documents/hooks/use-documents";
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
  UploadIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

export type CreateDocumentModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  documentType: DocumentType;
  projectId?: string;
  teamId: string;
  onSuccess?: (artifact: Document) => void;
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
  const [error, setError] = useState<string | null>(null);
  // Project selection (when projectId prop is not provided)
  const showProjectSelector = !projectId;
  const [selectedProjectId, setSelectedProjectId] = useState(projectId ?? "");
  const {
    data: teamProjects = [],
    isLoading: isLoadingProjects,
    isError: isProjectsError,
    refetch: refetchProjects,
  } = useProjectsByTeam(teamId, { enabled: open && showProjectSelector });

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
    setAdditionalRepos([]);
    setError(null);
    fileInputRef.current?.reset();
    if (showProjectSelector) {
      setSelectedProjectId("");
    }
  };

  const handleClose = () => {
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

  const isSubmitting = createDocument.isPending;

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
              {isProjectsError ? (
                <ProjectSelectorError onRetry={() => refetchProjects()} />
              ) : (
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
              )}
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
                  ? ISSUE_STATUS_OPTIONS
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
            />
          )}
        </div>

        <CreateDocumentFooter
          canSubmit={!!title.trim() && !!selectedProjectId}
          isSaving={createDocument.isPending}
          isSubmitting={isSubmitting}
          onCancel={handleClose}
          onSubmit={handleSubmit}
          typeLabel={typeLabel}
        />
      </DialogContent>
    </Dialog>
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
        <Command label="Search PRDs and issues">
          <CommandInput placeholder="Search PRDs and issues..." />
          <CommandList>
            <CommandEmpty>
              {loading ? "Loading…" : "No PRDs or issues in this project yet."}
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
      {loading ? "Loading…" : "Select a PRD or issue…"}
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
  isSubmitting,
  isSaving,
  canSubmit,
  typeLabel,
  onSubmit,
  onCancel,
}: Readonly<{
  isSubmitting: boolean;
  isSaving: boolean;
  canSubmit: boolean;
  typeLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
}>) {
  return (
    <DialogFooter>
      <Button onClick={onCancel} type="button" variant="outline">
        Cancel
      </Button>
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
    </DialogFooter>
  );
}

function PrdContentFields({
  content,
  onContentChange,
  fileInputRef,
  onError,
  onFileRead,
}: Readonly<{
  content: string;
  onContentChange: (value: string) => void;
  fileInputRef: React.RefObject<HiddenFileInputHandle | null>;
  onError: (error: string) => void;
  onFileRead: (content: string) => void;
}>) {
  return (
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
        placeholder="Paste or upload the markdown content for this PRD..."
        value={content}
      />
    </div>
  );
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

/**
 * Recoverable error state for the in-modal project selector. When the
 * team-projects request fails, the selector would otherwise render empty with
 * no explanation and no way forward, dead-ending creation. This surfaces the
 * failure and offers a retry so the selector can repopulate.
 */
function ProjectSelectorError({ onRetry }: Readonly<{ onRetry: () => void }>) {
  return (
    <Alert variant="error">
      <AlertDescription className="flex items-center justify-between gap-2">
        <span>Couldn't load projects.</span>
        <Button onClick={onRetry} size="sm" type="button" variant="outline">
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}
