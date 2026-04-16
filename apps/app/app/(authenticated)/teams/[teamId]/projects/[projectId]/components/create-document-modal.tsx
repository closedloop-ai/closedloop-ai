"use client";

import {
  DOCUMENT_STATUS_OPTIONS,
  type Document,
  DocumentStatus,
  DocumentType,
  type DocumentWithWorkstream,
} from "@repo/api/src/types/document";
import { RunLoopCommand } from "@repo/api/src/types/loop";
import { getProjectSettings } from "@repo/api/src/types/project";
import { Button } from "@repo/design-system/components/ui/button";
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
import { LoaderIcon, SparklesIcon, UploadIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  HiddenFileInput,
  type HiddenFileInputHandle,
} from "@/components/hidden-file-input";
import {
  useCreateDocument,
  useDocumentsByProject,
} from "@/hooks/queries/use-documents";
import {
  useGitHubBranches,
  useGitHubIntegrationStatus,
  useGitHubRepositories,
} from "@/hooks/queries/use-github-integration";
import { useRunLoop } from "@/hooks/queries/use-loops";
import { useProject, useProjectsByTeam } from "@/hooks/queries/use-projects";
import { useTeamMembers } from "@/hooks/queries/use-teams";
import {
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_TYPE_LABELS,
} from "@/lib/project-constants";
import { transformApiUserToSelectUser } from "@/lib/user-utils";

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

  // PRD selection for implementation plans
  const [selectedPrdId, setSelectedPrdId] = useState<string>("");

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

  // Fetch PRDs when modal opens for implementation plan
  const { data: artifacts = [], isLoading: loadingPrds } =
    useDocumentsByProject(selectedProjectId, {
      enabled: open && isImplementationPlan && !!selectedProjectId,
    });

  // Filter to get only PRDs
  const prds = useMemo(
    () => artifacts.filter((a) => a.type === "PRD"),
    [artifacts]
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
  const runLoop = useRunLoop();

  // Auto-select default branch only when no branch is selected yet
  useEffect(() => {
    if (branchesData?.branches && !targetBranch) {
      const defaultBranch = branchesData.branches.find((b) => b.isDefault);
      if (defaultBranch) {
        setTargetBranch(defaultBranch.name);
      }
    }
  }, [branchesData, targetBranch]);

  // Pre-populate fields from selected PRD for implementation plans
  useEffect(() => {
    if (!(isImplementationPlan && selectedPrdId)) {
      return;
    }

    const populatedFields = populateFieldsFromPrd(
      selectedPrdId,
      prds,
      repositories,
      transformedUsers
    );

    if (populatedFields) {
      setSelectedApprover(populatedFields.approver);
      setStatus(populatedFields.status);
      setTargetRepo(populatedFields.targetRepo);
      setTargetBranch(populatedFields.targetBranch);
      setSelectedRepoId(populatedFields.selectedRepoId);
    }
  }, [
    isImplementationPlan,
    selectedPrdId,
    prds,
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
    setSelectedPrdId("");
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
    setSelectedPrdId("");
    setReverseSynthesisLink("");
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
          selectedPrdId && {
            sourceId: selectedPrdId,
            sourceType: "DOCUMENT",
            sourceVersion: prds.find((p) => p.id === selectedPrdId)
              ?.latestVersion,
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

    createDocument.mutate(
      {
        projectId: selectedProjectId,
        type: documentType,
        title: title.trim(),
        fileName: fileName.trim() || undefined,
        content: artifactContent,
        approverId: selectedApprover?.id ?? undefined,
        status,
        targetRepo: targetRepo.trim() || undefined,
        targetBranch: targetBranch.trim() || undefined,
      },
      {
        onSuccess: (artifact) => {
          runLoop.mutate({
            documentId: artifact.id,
            command: RunLoopCommand.GeneratePrd,
          });
          handleClose();
          onSuccess?.(artifact);
        },
      }
    );
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
                htmlFor="source-prd"
              >
                Source PRD (optional)
              </Label>
              <Select onValueChange={setSelectedPrdId} value={selectedPrdId}>
                <SelectTrigger id="source-prd">
                  <SelectValue placeholder="Select a PRD..." />
                </SelectTrigger>
                <SelectContent>
                  <PrdSelectContent loading={loadingPrds} prds={prds} />
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                The implementation plan will be generated from this PRD.
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
          canGenerate={!!title.trim() && !!selectedProjectId}
          canSubmit={!!title.trim() && !!selectedProjectId}
          isGenerating={false}
          isPrd={isPrd}
          isSaving={createDocument.isPending}
          isSubmitting={isSubmitting}
          onCancel={handleClose}
          onGenerate={handleGenerate}
          onSubmit={handleSubmit}
          typeLabel={typeLabel}
        />
      </DialogContent>
    </Dialog>
  );
}

function PrdSelectContent({
  loading,
  prds,
}: Readonly<{
  loading: boolean;
  prds: DocumentWithWorkstream[];
}>) {
  if (loading) {
    return (
      <div className="flex items-center justify-center p-2">
        <LoaderIcon className="h-4 w-4 animate-spin" />
      </div>
    );
  }
  if (prds.length === 0) {
    return (
      <div className="p-2 text-center text-muted-foreground text-sm">
        No PRDs in this project. Create a PRD first.
      </div>
    );
  }
  return (
    <>
      {prds.map((prd) => (
        <SelectItem key={prd.id} value={prd.id}>
          {prd.title}
        </SelectItem>
      ))}
    </>
  );
}

/**
 * Pre-populates form fields from a selected PRD.
 * Returns updated field values or null if PRD not found.
 */
function populateFieldsFromPrd(
  prdId: string,
  prds: DocumentWithWorkstream[],
  repositories: Array<{ id: string; fullName: string }> | undefined,
  transformedUsers: User[]
): {
  approver: User | null;
  status: DocumentStatus;
  targetRepo: string;
  targetBranch: string;
  selectedRepoId: string;
} | null {
  const selectedPrd = prds.find((p) => p.id === prdId);
  if (!selectedPrd) {
    return null;
  }

  const matchingApprover = selectedPrd.approver
    ? transformedUsers.find((u) => u.id === selectedPrd.approver?.id)
    : null;

  const basicFields = {
    approver: matchingApprover || null,
    status: selectedPrd.status ?? DocumentStatus.Draft,
    targetRepo: selectedPrd.targetRepo ?? "",
    targetBranch: selectedPrd.targetBranch ?? "main",
  };

  // Resolve selectedRepoId from PRD's targetRepo
  let selectedRepoId = "";
  if (selectedPrd.targetRepo && repositories) {
    const matchingRepo = repositories.find(
      (repo) => repo.fullName === selectedPrd.targetRepo
    );
    if (matchingRepo) {
      selectedRepoId = matchingRepo.id;
    }
  }

  return {
    ...basicFields,
    selectedRepoId,
  };
}

function CreateDocumentFooter({
  isPrd,
  isSubmitting,
  isSaving,
  isGenerating,
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
          <Button disabled={isSubmitting || !canGenerate} onClick={onGenerate}>
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
