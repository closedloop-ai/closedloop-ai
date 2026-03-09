"use client";

import {
  type Artifact,
  ArtifactStatus,
  ArtifactType,
  type ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { toast } from "@repo/design-system/components/ui/sonner";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import {
  type User,
  UserSelectPopover,
} from "@repo/design-system/components/ui/user-select-popover";
import {
  ChevronDownIcon,
  LoaderIcon,
  SparklesIcon,
  UploadIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  HiddenFileInput,
  type HiddenFileInputHandle,
} from "@/components/hidden-file-input";
import {
  useArtifact,
  useArtifactsByProject,
  useCreateAndGenerateArtifact,
  useCreateAndInlineGeneratePRD,
  useCreateArtifact,
} from "@/hooks/queries/use-artifacts";
import {
  useGitHubBranches,
  useGitHubIntegrationStatus,
  useGitHubRepositories,
} from "@/hooks/queries/use-github-integration";
import { useProject } from "@/hooks/queries/use-projects";
import { useTeamMembers } from "@/hooks/queries/use-teams";
import { useOrgTemplateByType } from "@/hooks/queries/use-templates";
import { ARTIFACT_TYPE_LABELS } from "@/lib/project-constants";
import { transformApiUserToSelectUser } from "@/lib/user-utils";

function PrdSelectContent({
  loading,
  prds,
}: {
  loading: boolean;
  prds: ArtifactWithWorkstream[];
}) {
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
  prds: ArtifactWithWorkstream[],
  repositories: Array<{ id: string; fullName: string }> | undefined,
  transformedUsers: User[]
): {
  approver: User | null;
  status: ArtifactStatus;
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
    status: (selectedPrd.status ?? "DRAFT") as ArtifactStatus,
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

function CreateArtifactFooter({
  isPrd,
  isSubmitting,
  isSaving,
  isGenerating,
  canSubmit,
  typeLabel,
  onSubmit,
  onQuickGenerate,
  onDeepGenerate,
  onCancel,
}: {
  isPrd: boolean;
  isSubmitting: boolean;
  isSaving: boolean;
  isGenerating: boolean;
  canSubmit: boolean;
  typeLabel: string;
  onSubmit: () => void;
  onQuickGenerate: () => void;
  onDeepGenerate: () => void;
  onCancel: () => void;
}) {
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
                <LoaderIcon className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save"
            )}
          </Button>
          {isGenerating ? (
            <Button disabled>
              <LoaderIcon className="mr-2 h-4 w-4 animate-spin" />
              Generating...
            </Button>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button disabled={isSubmitting || !canSubmit}>
                  <SparklesIcon className="mr-2 h-4 w-4" />
                  Generate
                  <ChevronDownIcon className="ml-2 h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onQuickGenerate}>
                  <SparklesIcon className="mr-2 h-4 w-4" />
                  Quick PRD
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onDeepGenerate}>
                  <SparklesIcon className="mr-2 h-4 w-4" />
                  Deep PRD
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </>
      ) : (
        <Button disabled={isSubmitting || !canSubmit} onClick={onSubmit}>
          {isSaving ? (
            <>
              <LoaderIcon className="mr-2 h-4 w-4 animate-spin" />
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

type CreateArtifactModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artifactType: ArtifactType;
  projectId: string;
  teamId: string;
  onSuccess?: (artifact: Artifact) => void;
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: complex form with multiple submission paths (save, quick generate, deep generate)
export function CreateArtifactModal({
  open,
  onOpenChange,
  artifactType,
  projectId,
  teamId,
  onSuccess,
}: CreateArtifactModalProps) {
  const fileInputRef = useRef<HiddenFileInputHandle>(null);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [fileName, setFileName] = useState("");
  const [content, setContent] = useState("");

  // PRD-specific fields
  const [selectedApprover, setSelectedApprover] = useState<User | null>(null);
  const [status, setStatus] = useState<ArtifactStatus>("DRAFT");
  const [targetRepo, setTargetRepo] = useState("");
  const [targetBranch, setTargetBranch] = useState("main");
  const [selectedRepoId, setSelectedRepoId] = useState<string>("");
  const [reverseSynthesisLink, setReverseSynthesisLink] = useState("");

  // PRD selection for implementation plans
  const [selectedPrdId, setSelectedPrdId] = useState<string>("");

  const { data: project } = useProject(projectId);
  const projectSettings = getProjectSettings(project?.settings ?? {});
  const defaultRepo = projectSettings.defaultRepository;

  const typeLabel = ARTIFACT_TYPE_LABELS[artifactType] ?? artifactType;
  const isImplementationPlan = artifactType === ArtifactType.ImplementationPlan;
  const isPrd = artifactType === ArtifactType.Prd;

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

  // Fetch template for PRD type (two-step: get template artifact, then fetch its content via detail)
  const { data: template } = useOrgTemplateByType(isPrd ? artifactType : "", {
    enabled: open && isPrd,
  });
  const { data: templateDetail } = useArtifact(template?.id ?? "", undefined, {
    enabled: !!template?.id,
  });

  // Fetch PRDs when modal opens for implementation plan
  const { data: artifacts = [], isLoading: loadingPrds } =
    useArtifactsByProject(projectId, {
      enabled: open && isImplementationPlan,
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
  const createArtifact = useCreateArtifact();
  const createAndInlineGenerate = useCreateAndInlineGeneratePRD();
  const createAndDeepGenerate = useCreateAndGenerateArtifact();

  // Auto-select default branch only when no branch is selected yet
  useEffect(() => {
    if (branchesData?.branches && !targetBranch) {
      const defaultBranch = branchesData.branches.find((b) => b.isDefault);
      if (defaultBranch) {
        setTargetBranch(defaultBranch.name);
      }
    }
  }, [branchesData, targetBranch]);

  // Pre-populate from project default repository when modal opens
  const defaultRepoId = defaultRepo?.repoId;
  const defaultRepoFullName = defaultRepo?.repoFullName;
  const defaultRepoBranch = defaultRepo?.branch;
  useEffect(() => {
    if (
      open &&
      defaultRepoId &&
      defaultRepoFullName &&
      defaultRepoBranch &&
      !targetRepo &&
      !selectedRepoId
    ) {
      setSelectedRepoId(defaultRepoId);
      setTargetRepo(defaultRepoFullName);
      setTargetBranch(defaultRepoBranch);
    }
  }, [
    open,
    defaultRepoId,
    defaultRepoFullName,
    defaultRepoBranch,
    targetRepo,
    selectedRepoId,
  ]);

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

  // Prefill content from template when loaded (only on initial load)
  useEffect(() => {
    const templateContent = templateDetail?.version?.content;
    if (templateContent) {
      setContent((current) => current || templateContent);
    }
  }, [templateDetail]);

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
    setTargetRepo(defaultRepo?.repoFullName ?? "");
    setTargetBranch(defaultRepo?.branch ?? "main");
    setSelectedRepoId(defaultRepo?.repoId ?? "");
    setSelectedPrdId("");
    setReverseSynthesisLink("");
    setError(null);
    fileInputRef.current?.reset();
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
    if (!title.trim()) {
      setError("Please enter a title");
      return;
    }

    createArtifact.mutate(
      {
        projectId,
        type: artifactType,
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
            sourceType: "ARTIFACT",
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

  const prdInput = {
    projectId,
    type: artifactType,
    title: title.trim(),
    fileName: fileName.trim() || undefined,
    content: content.trim(),
    approverId: selectedApprover?.id ?? undefined,
    status,
    targetRepo: targetRepo.trim() || undefined,
    targetBranch: targetBranch.trim() || undefined,
  };

  const handleQuickGenerate = () => {
    setError(null);
    if (!title.trim()) {
      setError("Please enter a title");
      return;
    }

    createAndInlineGenerate.mutate(
      {
        input: prdInput,
        reverseSynthesisLink: reverseSynthesisLink.trim() || undefined,
      },
      {
        onSuccess: ({ artifact, generationError }) => {
          handleClose();
          onSuccess?.(artifact);
          if (generationError) {
            toast.error(`Quick PRD generation failed: ${generationError}`);
          }
        },
      }
    );
  };

  const handleDeepGenerate = () => {
    setError(null);
    if (!title.trim()) {
      setError("Please enter a title");
      return;
    }

    createAndDeepGenerate.mutate(prdInput, {
      onSuccess: (artifact) => {
        handleClose();
        onSuccess?.(artifact);
      },
    });
  };

  const isGenerating =
    createAndInlineGenerate.isPending || createAndDeepGenerate.isPending;
  const isSubmitting = createArtifact.isPending || isGenerating;

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

          <div className="space-y-2">
            <Label
              className="font-normal text-muted-foreground text-xs"
              htmlFor="artifact-target-repo"
            >
              Target Repository (for code generation)
            </Label>
            {githubStatus?.connected === false ? (
              <div className="rounded-md border border-muted bg-muted/20 p-3 text-muted-foreground text-sm">
                Connect GitHub to select a repository
              </div>
            ) : (
              <Select
                disabled={isLoadingGitHubStatus || isLoadingRepos}
                onValueChange={handleRepositoryChange}
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
              onValueChange={setTargetBranch}
              value={targetBranch}
            >
              <SelectTrigger id="artifact-target-branch">
                <SelectValue placeholder={branchPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                {branchesData?.branches.map((branch) => (
                  <SelectItem key={branch.name} value={branch.name}>
                    {branch.name}
                    {branch.isDefault ? " (default)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

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
                {Object.values(ArtifactStatus).map((statusOption) => (
                  <SelectItem key={statusOption} value={statusOption}>
                    {statusOption.charAt(0) +
                      statusOption.slice(1).toLowerCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isPrd && (
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
                    <UploadIcon className="mr-2 h-4 w-4" />
                    Upload .md
                  </Button>
                </div>
                <HiddenFileInput
                  accept=".md"
                  aria-label="Upload markdown file for artifact content"
                  onError={setError}
                  onFileRead={handleFileRead}
                  ref={fileInputRef}
                />
                <Textarea
                  className="min-h-[120px] font-mono text-sm"
                  id="artifact-content"
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Paste markdown content or a prompt for AI generation..."
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
                  onChange={(e) => setReverseSynthesisLink(e.target.value)}
                  placeholder="https://github.com/org/repo or documentation URL"
                  value={reverseSynthesisLink}
                />
                <p className="text-muted-foreground text-xs">
                  Provide a URL for the AI to reference when generating the PRD.
                </p>
              </div>
            </>
          )}
        </div>

        <CreateArtifactFooter
          canSubmit={!!title.trim()}
          isGenerating={isGenerating}
          isPrd={isPrd}
          isSaving={createArtifact.isPending}
          isSubmitting={isSubmitting}
          onCancel={handleClose}
          onDeepGenerate={handleDeepGenerate}
          onQuickGenerate={handleQuickGenerate}
          onSubmit={handleSubmit}
          typeLabel={typeLabel}
        />
      </DialogContent>
    </Dialog>
  );
}
