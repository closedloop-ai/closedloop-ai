"use client";

import { EntityType } from "@repo/api/src/types/entity-link";
import { getProjectSettings } from "@repo/api/src/types/project";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/design-system/components/ui/dialog";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { LoaderIcon, PlusIcon, SparklesIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  useArtifacts,
  useCreateAndGenerateArtifact,
  useCreateArtifact,
} from "@/hooks/queries/use-artifacts";
import { useProject, useProjects } from "@/hooks/queries/use-projects";
import { PlanPreview, PrdSelector, ProjectSelector } from "./plan-form-fields";
import { buildCreateInput, useModalOpenState } from "./plan-form-utils";
import {
  generateFileNameFromTitle,
  generatePlanFileName,
  getFinalFileName,
  type PlanSource,
} from "./plan-source";
import { RepositoryBranchFields } from "./repository-branch-fields";

type NewPlanModalProps = {
  source?: PlanSource;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function NewPlanModal({
  source,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: NewPlanModalProps = {}) {
  const router = useRouter();
  const createPlan = useCreateArtifact();
  const createAndGeneratePlan = useCreateAndGenerateArtifact();
  const { open, setOpen, isControlled } = useModalOpenState(
    controlledOpen,
    controlledOnOpenChange
  );
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [selectedSourceId, setSelectedSourceId] = useState(source?.id ?? "");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [title, setTitle] = useState(() =>
    source ? `Plan: ${source.title}` : ""
  );
  const [fileName, setFileName] = useState(() =>
    source ? generatePlanFileName(source) : ""
  );
  const [content, setContent] = useState("");
  const [targetRepo, setTargetRepo] = useState(() => source?.targetRepo ?? "");
  const [targetBranch, setTargetBranch] = useState(
    () => source?.targetBranch ?? ""
  );
  const [selectedRepoId, setSelectedRepoId] = useState("");

  // Fetch project details for default repository
  const effectiveProjectId = source?.projectId ?? selectedProjectId;
  const { data: projectData } = useProject(effectiveProjectId ?? "");
  const projectSettings = getProjectSettings(projectData?.settings ?? {});

  // Fetch PRDs when modal opens (skip if we have a source)
  const { data: prds = [], isLoading: loadingPrds } = useArtifacts(
    { type: "PRD", projectId: selectedProjectId },
    {
      enabled: open && !!selectedProjectId && !source,
    }
  );

  // Fetch projects when modal opens and no source is selected
  const { data: projects = [], isLoading: loadingProjects } = useProjects(
    undefined,
    { enabled: open }
  );

  // Get the selected source (either from prop or from dropdown PRD)
  const selectedPrd = prds.find((p) => p.id === selectedSourceId);
  const selectedSource: PlanSource | undefined = useMemo(() => {
    return (
      source ??
      (selectedPrd
        ? {
            ...selectedPrd,
            sourceType: EntityType.Artifact,
          }
        : undefined)
    );
  }, [source, selectedPrd]);

  // Update title, filename, and repo/branch when source is selected from dropdown
  useEffect(() => {
    if (selectedSource && !source) {
      setTitle(`Plan: ${selectedSource.title}`);
      setFileName(generatePlanFileName(selectedSource));
      if (selectedSource.targetRepo) {
        setTargetRepo(selectedSource.targetRepo);
      }
      if (selectedSource.targetBranch) {
        setTargetBranch(selectedSource.targetBranch);
      }
    }
  }, [selectedSource, source]);

  // Pre-populate from project default repository when modal opens
  useEffect(() => {
    const defaultRepo = projectSettings.defaultRepository;
    if (open && !(source?.targetRepo || targetRepo) && defaultRepo) {
      setSelectedRepoId(defaultRepo.repoId);
      setTargetRepo(defaultRepo.repoFullName);
      setTargetBranch(defaultRepo.branch);
    }
  }, [open, projectSettings.defaultRepository, source?.targetRepo, targetRepo]);

  const handleTitleChange = (value: string): void => {
    setTitle(value);
    if (value.trim()) {
      setFileName(generateFileNameFromTitle(value));
    } else {
      setFileName("");
    }
  };

  const resetForm = () => {
    setSelectedSourceId(source?.id ?? "");
    setSelectedProjectId("");
    setTitle("");
    setFileName("");
    setContent("");
    setTargetRepo(source?.targetRepo ?? "");
    setTargetBranch(source?.targetBranch ?? "");
    setSelectedRepoId("");
    setError(null);
  };

  const handleSubmit = () => {
    setError(null);

    if (!title.trim()) {
      setError("Please enter a title");
      return;
    }

    const formState = {
      selectedSourceId,
      selectedProjectId,
      title,
      fileName,
      content,
      targetRepo,
      targetBranch,
    };

    const finalFileName = getFinalFileName(
      formState.fileName,
      formState.title,
      selectedSource
    );
    const createConfig = buildCreateInput(
      formState,
      finalFileName,
      selectedSource
    );

    const onSuccess = (artifact: { slug: string }) => {
      setOpen(false);
      resetForm();
      router.push(`/implementation-plans/${artifact.slug}`);
    };

    if (createConfig.type === "createAndGenerate") {
      createAndGeneratePlan.mutate(createConfig.input, { onSuccess });
    } else {
      createPlan.mutate(createConfig.input, { onSuccess });
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (!newOpen) {
      resetForm();
    }
  };

  const showProjectSelector = !selectedSource?.projectId;
  const isSubmitting = createPlan.isPending || createAndGeneratePlan.isPending;

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      {!isControlled && (
        <DialogTrigger asChild>
          <Button>
            <PlusIcon className="mr-2 h-4 w-4" />
            New Plan
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            <div className="flex items-center gap-2">
              <SparklesIcon className="h-5 w-5" />
              Generate Implementation Plan
            </div>
          </DialogTitle>
          <DialogDescription className="sr-only">
            Create an implementation plan from a PRD or Issue.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error ? (
            <div
              className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-destructive text-sm"
              id="title-error"
              role="alert"
            >
              {error}
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="new-title">
              Title<span className="text-destructive">*</span>
            </Label>
            <Input
              aria-describedby={error ? "title-error" : ""}
              aria-invalid={error ? "true" : "false"}
              id="new-title"
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder="Plan: Dashboard Redesign"
              value={title}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-filename">File name</Label>
            <Input
              id="new-filename"
              onChange={(e) => setFileName(e.target.value)}
              placeholder={fileName}
              value={fileName}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="source-prd">
              Source{source ? "" : " PRD"}{" "}
              <span className="text-muted-foreground">(optional)</span>
            </Label>
            {source ? (
              <div className="flex h-10 w-full items-center rounded-md border border-input bg-muted px-3 py-2 text-sm">
                {source.title}
              </div>
            ) : (
              <PrdSelector
                isLoading={loadingPrds}
                onSelect={setSelectedSourceId}
                prds={prds}
                selectedPrdId={selectedSourceId}
              />
            )}
          </div>

          {showProjectSelector ? (
            <div className="space-y-2">
              <Label htmlFor="project">
                Project{" "}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <ProjectSelector
                isLoading={loadingProjects}
                onSelect={setSelectedProjectId}
                projects={projects}
                selectedProjectId={selectedProjectId}
              />
            </div>
          ) : null}

          <RepositoryBranchFields
            onBranchChange={setTargetBranch}
            onRepositoryChange={(repoId, fullName) => {
              setSelectedRepoId(repoId);
              setTargetRepo(fullName);
              setTargetBranch("");
            }}
            selectedRepoId={selectedRepoId}
            targetBranch={targetBranch}
          />

          {selectedSource ? (
            <PlanPreview
              fileName={fileName}
              source={selectedSource}
              targetBranch={targetBranch}
              targetRepo={targetRepo}
              title={title}
            />
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="new-content">Additional context</Label>
            <Textarea
              className="min-h-[75px] font-mono text-sm"
              id="new-content"
              onChange={(e) => setContent(e.target.value)}
              value={content}
            />
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => handleOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={isSubmitting || !title.trim()}
            onClick={handleSubmit}
          >
            {isSubmitting ? (
              <>
                <LoaderIcon className="mr-2 h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <SparklesIcon className="mr-2 h-4 w-4" />
                {selectedSource ? "Generate Plan" : "Create Plan"}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
