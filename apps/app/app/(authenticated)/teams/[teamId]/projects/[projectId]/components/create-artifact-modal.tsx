"use client";

import {
  type Artifact,
  ArtifactStatus,
  type ArtifactType,
  type ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
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
import { LoaderIcon, UploadIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  useArtifactsByProject,
  useCreateArtifact,
} from "@/hooks/queries/use-artifacts";
import {
  useGitHubBranches,
  useGitHubIntegrationStatus,
  useGitHubRepositories,
} from "@/hooks/queries/use-github-integration";
import { useOrgTemplateByType } from "@/hooks/queries/use-templates";
import { ARTIFACT_TYPE_LABELS } from "@/lib/project-constants";

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
  repositories: Array<{ id: string; fullName: string }> | undefined
): {
  approver: string;
  status: ArtifactStatus;
  targetRepo: string;
  targetBranch: string;
  selectedRepoId: string;
} | null {
  const selectedPrd = prds.find((p) => p.id === prdId);
  if (!selectedPrd) {
    return null;
  }

  const basicFields = {
    approver: selectedPrd.approver ?? "",
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

type CreateArtifactModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artifactType: ArtifactType;
  projectId: string;
  onSuccess?: (artifact: Artifact) => void;
};

export function CreateArtifactModal({
  open,
  onOpenChange,
  artifactType,
  projectId,
  onSuccess,
}: CreateArtifactModalProps) {
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [fileName, setFileName] = useState("");
  const [content, setContent] = useState("");

  // PRD-specific fields
  const [approver, setApprover] = useState("");
  const [status, setStatus] = useState<ArtifactStatus>("DRAFT");
  const [targetRepo, setTargetRepo] = useState("");
  const [targetBranch, setTargetBranch] = useState("main");
  const [selectedRepoId, setSelectedRepoId] = useState<string>("");

  // PRD selection for implementation plans
  const [selectedPrdId, setSelectedPrdId] = useState<string>("");

  const fileInputRef = useRef<HTMLInputElement>(null);

  const typeLabel = ARTIFACT_TYPE_LABELS[artifactType] || artifactType;
  const isImplementationPlan = artifactType === "IMPLEMENTATION_PLAN";
  const supportsTemplate =
    artifactType === "PRD" ||
    artifactType === "ISSUE" ||
    artifactType === "BUG";
  const supportsContentUpload =
    artifactType === "PRD" ||
    artifactType === "ISSUE" ||
    artifactType === "BUG";

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

  // Fetch template for types that have templates
  const { data: template } = useOrgTemplateByType(
    supportsTemplate ? artifactType : "",
    { enabled: open && supportsTemplate }
  );

  // Fetch PRDs when modal opens for implementation plan
  const { data: artifacts = [], isLoading: loadingPrds } =
    useArtifactsByProject(projectId, true, {
      enabled: open && isImplementationPlan,
    });

  // Filter to get only PRDs
  const prds = useMemo(
    () => artifacts.filter((a) => a.type === "PRD"),
    [artifacts]
  );

  // Create artifact mutation
  const createArtifact = useCreateArtifact();

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
      repositories
    );

    if (populatedFields) {
      setApprover(populatedFields.approver);
      setStatus(populatedFields.status);
      setTargetRepo(populatedFields.targetRepo);
      setTargetBranch(populatedFields.targetBranch);
      setSelectedRepoId(populatedFields.selectedRepoId);
    }
  }, [isImplementationPlan, selectedPrdId, prds, repositories]);

  // Prefill content from template when loaded (only on initial load)
  useEffect(() => {
    if (template?.content) {
      setContent((current) => (current ? current : (template.content ?? "")));
    }
  }, [template]);

  // Compute branch placeholder based on state
  const getBranchPlaceholder = () => {
    if (!selectedRepoId) {
      return "Select a repository first";
    }
    if (isLoadingBranches) {
      return "Loading branches...";
    }
    return "Select a branch";
  };

  const handleTitleChange = (value: string) => {
    setTitle(value);
    // Auto-generate filename from title
    if (value.trim()) {
      const generatedFileName = value
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, "-")
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
    setApprover("");
    setStatus("DRAFT");
    setTargetRepo("");
    setTargetBranch("main");
    setSelectedRepoId("");
    setSelectedPrdId("");
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleClose = () => {
    onOpenChange(false);
    resetForm();
  };

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const content = await file.text();
      if (!content.trim()) {
        setError("File is empty");
        return;
      }
      setContent(content);
    } catch (_error) {
      setError("Failed to read file. Please try again.");
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleSubmit = () => {
    setError(null);

    if (!title.trim()) {
      setError("Please enter a title");
      return;
    }

    if (isImplementationPlan && !selectedPrdId) {
      setError("Please select a PRD");
      return;
    }

    createArtifact.mutate(
      {
        projectId,
        type: artifactType,
        title: title.trim(),
        fileName: fileName.trim() || undefined,
        content: content.trim() || undefined,
        parentId: isImplementationPlan ? selectedPrdId : undefined,
        // Common fields for PRD and Implementation Plan
        approver: approver.trim() || undefined,
        status,
        targetRepo: targetRepo.trim() || undefined,
        targetBranch: targetBranch.trim() || undefined,
      },
      {
        onSuccess: (artifact) => {
          handleClose();
          onSuccess?.(artifact);
        },
        onError: (err) => {
          setError(
            err instanceof Error ? err.message : "Failed to create artifact"
          );
        },
      }
    );
  };

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
          <DialogDescription>
            Create a new {typeLabel.toLowerCase()} for this project.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-destructive text-sm">
              {error}
            </div>
          ) : null}

          {isImplementationPlan ? (
            <div className="space-y-2">
              <Label htmlFor="source-prd">
                Source PRD<span className="text-destructive">*</span>
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
            <Label htmlFor="artifact-title">
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
            <Label htmlFor="artifact-filename">File name</Label>
            <Input
              id="artifact-filename"
              onChange={(e) => setFileName(e.target.value)}
              placeholder="auto-generated-from-title.md"
              value={fileName}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="artifact-approver">Approver</Label>
            <Input
              id="artifact-approver"
              onChange={(e) => setApprover(e.target.value)}
              placeholder="Approver name"
              value={approver}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="artifact-target-repo">
              Target Repository{" "}
              <span className="text-muted-foreground text-xs">
                (for code generation)
              </span>
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
            <Label htmlFor="artifact-target-branch">Target Branch</Label>
            <Select
              disabled={!selectedRepoId || isLoadingBranches}
              onValueChange={setTargetBranch}
              value={targetBranch}
            >
              <SelectTrigger id="artifact-target-branch">
                <SelectValue placeholder={getBranchPlaceholder()} />
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
            <Label>Status</Label>
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

          {supportsContentUpload && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="artifact-content">
                  Content{" "}
                  <span className="text-muted-foreground text-xs">
                    (optional)
                  </span>
                </Label>
                <Button
                  onClick={() => fileInputRef.current?.click()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <UploadIcon className="mr-2 h-4 w-4" />
                  Upload .md
                </Button>
              </div>
              <input
                accept=".md"
                aria-label="Upload markdown file for artifact content"
                className="hidden"
                onChange={handleFileChange}
                ref={fileInputRef}
                type="file"
              />
              <Textarea
                className="min-h-[120px] font-mono text-sm"
                id="artifact-content"
                onChange={(e) => setContent(e.target.value)}
                placeholder="Paste markdown content here..."
                value={content}
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={handleClose} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={
              createArtifact.isPending ||
              !title.trim() ||
              (isImplementationPlan ? !selectedPrdId : false)
            }
            onClick={handleSubmit}
          >
            {createArtifact.isPending ? (
              <>
                <LoaderIcon className="mr-2 h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              `Create ${typeLabel}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
