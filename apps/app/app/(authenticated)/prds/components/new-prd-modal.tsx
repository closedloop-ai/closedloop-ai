"use client";

import { ArtifactStatus } from "@repo/api/src/types/artifact";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { LoaderIcon, PlusIcon, UploadIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  HiddenFileInput,
  type HiddenFileInputHandle,
} from "@/components/hidden-file-input";
import { useCreateArtifact } from "@/hooks/queries/use-artifacts";
import {
  useGitHubBranches,
  useGitHubIntegrationStatus,
  useGitHubRepositories,
} from "@/hooks/queries/use-github-integration";

export function NewPRDModal() {
  const router = useRouter();
  const createArtifact = useCreateArtifact();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [fileName, setFileName] = useState("");
  const [approver, setApprover] = useState("");
  const [status, setStatus] = useState<ArtifactStatus>("DRAFT");
  const [content, setContent] = useState("");
  const [targetRepo, setTargetRepo] = useState("");
  const [targetBranch, setTargetBranch] = useState("main");
  const [selectedRepoId, setSelectedRepoId] = useState<string>("");
  const fileInputRef = useRef<HiddenFileInputHandle>(null);

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

  // Auto-select default branch only when no branch is selected yet
  useEffect(() => {
    if (branchesData?.branches && !targetBranch) {
      const defaultBranch = branchesData.branches.find((b) => b.isDefault);
      if (defaultBranch) {
        setTargetBranch(defaultBranch.name);
      }
    }
  }, [branchesData, targetBranch]);

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
    setApprover("");
    setStatus("DRAFT");
    setContent("");
    setTargetRepo("");
    setTargetBranch("main");
    setSelectedRepoId("");
    setError(null);
    fileInputRef.current?.reset();
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
        subtype: "PRD",
        title: title.trim(),
        fileName: fileName.trim() || undefined,
        approver: approver.trim() || undefined,
        status,
        content: content.trim() || undefined,
        targetRepo: targetRepo.trim() || undefined,
        targetBranch: targetBranch.trim() || undefined,
      },
      {
        onSuccess: (artifact) => {
          setOpen(false);
          resetForm();
          router.push(`/prds/${artifact.documentSlug}`);
        },
      }
    );
  };

  return (
    <Dialog
      onOpenChange={(newOpen) => {
        setOpen(newOpen);
        if (!newOpen) {
          resetForm();
        }
      }}
      open={open}
    >
      <DialogTrigger asChild>
        <Button>
          <PlusIcon className="mr-2 h-4 w-4" />
          New PRD
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Create New PRD</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-destructive text-sm">
              {error}
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="new-title">
              Title<span className="text-destructive">*</span>
            </Label>
            <Input
              id="new-title"
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder="Checkout Revamp"
              value={title}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-filename">File name</Label>
            <Input
              id="new-filename"
              onChange={(e) => setFileName(e.target.value)}
              placeholder="checkout-revamp.md"
              value={fileName}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-approver">Approver</Label>
            <Input
              id="new-approver"
              onChange={(e) => setApprover(e.target.value)}
              placeholder="Approver name"
              value={approver}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-target-repo">
              Target Repository{" "}
              <span className="text-muted-foreground text-xs">
                (for plan generation)
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
                <SelectTrigger id="new-target-repo">
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
            <Label htmlFor="new-target-branch">Target Branch</Label>
            <Select
              disabled={!selectedRepoId || isLoadingBranches}
              onValueChange={setTargetBranch}
              value={targetBranch}
            >
              <SelectTrigger id="new-target-branch">
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

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="new-content">
                Content{" "}
                <span className="text-muted-foreground text-xs">
                  (optional - paste markdown here)
                </span>
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
              aria-label="Upload markdown file for PRD content"
              onError={setError}
              onFileRead={handleFileRead}
              ref={fileInputRef}
            />
            <Textarea
              className="min-h-[150px] font-mono text-sm"
              id="new-content"
              onChange={(e) => setContent(e.target.value)}
              placeholder="# My PRD&#10;&#10;## Problem&#10;&#10;Describe the problem..."
              value={content}
            />
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => setOpen(false)} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={createArtifact.isPending || !title.trim()}
            onClick={handleSubmit}
          >
            {createArtifact.isPending ? (
              <>
                <LoaderIcon className="mr-2 h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              "Create PRD"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
