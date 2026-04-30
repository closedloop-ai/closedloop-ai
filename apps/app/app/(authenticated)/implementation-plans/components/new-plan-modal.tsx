"use client";

import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
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
import { useEffect, useMemo, useRef, useState } from "react";
import {
  useCreateAndGenerateDocument,
  useCreateDocument,
  useDocuments,
} from "@/hooks/queries/use-documents";
import { useProject, useProjects } from "@/hooks/queries/use-projects";
import { useMultiRepoExecuteEnabled } from "@/hooks/use-multi-repo-execute-enabled";
import { AdditionalReposPicker } from "./additional-repos-picker";
import { PlanPreview, PrdSelector, ProjectSelector } from "./plan-form-fields";
import {
  buildCreateInput,
  type FormState,
  normalizeAdditionalRepos,
  useModalOpenState,
} from "./plan-form-utils";
import {
  generateFileNameFromTitle,
  generatePlanFileName,
  getFinalFileName,
  type PlanSource,
} from "./plan-source";
import { RepoBranchSelector } from "./repo-branch-selector";

type NewPlanModalProps = {
  source?: PlanSource;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

function validateMissingRepo(
  isLoadingProject: boolean,
  targetRepo: string,
  defaultRepoFullName: string | undefined
): boolean {
  return !(isLoadingProject || targetRepo || defaultRepoFullName);
}

function isCreateSubmitDisabled(
  isSubmitting: boolean,
  titleTrimmed: boolean,
  selectedSource: PlanSource | undefined,
  missingRepo: boolean,
  incompleteAdditionalRepos: boolean
): boolean {
  return (
    isSubmitting ||
    !titleTrimmed ||
    (!!selectedSource && (missingRepo || incompleteAdditionalRepos))
  );
}

type SubmitCreatePlanArgs = {
  formState: FormState;
  selectedSource: PlanSource | undefined;
  showPicker: boolean;
  additionalRepos: AdditionalRepoRef[];
  createPlan: ReturnType<typeof useCreateDocument>;
  createAndGeneratePlan: ReturnType<typeof useCreateAndGenerateDocument>;
  onSuccess: (document: { slug: string }) => void;
};

function submitCreatePlan({
  formState,
  selectedSource,
  showPicker,
  additionalRepos,
  createPlan,
  createAndGeneratePlan,
  onSuccess,
}: SubmitCreatePlanArgs): void {
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

  if (createConfig.type === "createAndGenerate") {
    const submitAdditionalRepos = showPicker
      ? normalizeAdditionalRepos(additionalRepos)
      : undefined;
    createAndGeneratePlan.mutate(
      { input: createConfig.input, additionalRepos: submitAdditionalRepos },
      { onSuccess }
    );
    return;
  }
  createPlan.mutate(createConfig.input, { onSuccess });
}

export function NewPlanModal({
  source,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: NewPlanModalProps = {}) {
  const router = useRouter();
  const createPlan = useCreateDocument();
  const createAndGeneratePlan = useCreateAndGenerateDocument();
  const { open, setOpen, isControlled } = useModalOpenState(
    controlledOpen,
    controlledOnOpenChange
  );
  const [error, setError] = useState<string | null>(null);
  const showPicker = useMultiRepoExecuteEnabled();

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
  const [additionalRepos, setAdditionalRepos] = useState<AdditionalRepoRef[]>(
    []
  );
  const [incompleteAdditionalRepos, setIncompleteAdditionalRepos] =
    useState(false);
  const hasPrePopulated = useRef(false);

  // Fetch project details for default repository
  const effectiveProjectId = source?.projectId ?? selectedProjectId;
  const { data: projectData, isLoading: isLoadingProject } = useProject(
    effectiveProjectId ?? ""
  );
  const projectSettings = getProjectSettings(projectData?.settings ?? {});
  const missingRepo = validateMissingRepo(
    isLoadingProject,
    targetRepo,
    projectSettings.defaultRepository?.repoFullName
  );

  // Fetch PRDs when modal opens (skip if we have a source)
  const { data: prds = [], isLoading: loadingPrds } = useDocuments(
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
    return source ?? selectedPrd ?? undefined;
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
    if (
      open &&
      !(source?.targetRepo || targetRepo) &&
      defaultRepo &&
      !hasPrePopulated.current
    ) {
      setSelectedRepoId(defaultRepo.repoId);
      setTargetRepo(defaultRepo.repoFullName);
      setTargetBranch(defaultRepo.branch);
      hasPrePopulated.current = true;
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
    setAdditionalRepos([]);
    setIncompleteAdditionalRepos(false);
    setError(null);
    hasPrePopulated.current = false;
  };

  const handleSubmit = () => {
    setError(null);

    if (!title.trim()) {
      setError("Please enter a title");
      return;
    }

    submitCreatePlan({
      formState: {
        selectedSourceId,
        selectedProjectId,
        title,
        fileName,
        content,
        targetRepo,
        targetBranch,
      },
      selectedSource,
      showPicker,
      additionalRepos,
      createPlan,
      createAndGeneratePlan,
      onSuccess: (document) => {
        setOpen(false);
        resetForm();
        router.push(`/implementation-plans/${document.slug}`);
      },
    });
  };

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (!newOpen) {
      resetForm();
    }
  };

  const handleRepositoryChange = (repoId: string, fullName: string) => {
    setSelectedRepoId(repoId);
    setTargetRepo(fullName);
    setTargetBranch("");
  };

  const showProjectSelector = !selectedSource?.projectId;
  const isSubmitting = createPlan.isPending || createAndGeneratePlan.isPending;

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      {!isControlled && (
        <DialogTrigger asChild>
          <Button>
            <PlusIcon className="h-4 w-4" />
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
            Create an implementation plan from a PRD or Feature.
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
              <div className="flex h-10 w-full items-center rounded-md border border-input-border bg-muted px-3 py-2 text-sm">
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

          <TargetRepoBranchFields
            onBranchChange={setTargetBranch}
            onRepoChange={handleRepositoryChange}
            selectedBranch={targetBranch}
            selectedRepoId={selectedRepoId}
            targetRepo={targetRepo}
          />

          {showPicker ? (
            <AdditionalReposPicker
              initialValue={additionalRepos}
              onChange={setAdditionalRepos}
              onIncompleteChange={setIncompleteAdditionalRepos}
              targetRepo={targetRepo}
            />
          ) : null}

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

          <PlanSubmitValidationMessages
            incompleteAdditionalRepos={incompleteAdditionalRepos}
            missingRepo={missingRepo}
            selectedSource={selectedSource}
          />
        </div>

        <DialogFooter>
          <Button onClick={() => handleOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={isCreateSubmitDisabled(
              isSubmitting,
              title.trim().length > 0,
              selectedSource,
              missingRepo,
              incompleteAdditionalRepos
            )}
            onClick={handleSubmit}
          >
            {isSubmitting ? (
              <>
                <LoaderIcon className="h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <SparklesIcon className="h-4 w-4" />
                {selectedSource ? "Generate Plan" : "Create Plan"}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TargetRepoBranchFields({
  targetRepo,
  selectedRepoId,
  selectedBranch,
  onRepoChange,
  onBranchChange,
}: {
  targetRepo: string;
  selectedRepoId: string;
  selectedBranch: string;
  onRepoChange: (repoId: string, fullName: string) => void;
  onBranchChange: (branch: string) => void;
}) {
  return (
    <RepoBranchSelector
      branchInputId="target-branch"
      branchLabel="Target Branch"
      onBranchChange={onBranchChange}
      onRepoChange={onRepoChange}
      repoInputId="target-repo"
      repoLabel={
        <>
          Target Repository{" "}
          <span className="text-muted-foreground text-xs">(owner/repo)</span>
        </>
      }
      repoTriggerFallback={targetRepo ? <span>{targetRepo}</span> : null}
      selectedBranch={selectedBranch}
      selectedRepoId={selectedRepoId}
    />
  );
}

function PlanSubmitValidationMessages({
  selectedSource,
  missingRepo,
  incompleteAdditionalRepos,
}: {
  selectedSource: PlanSource | undefined;
  missingRepo: boolean;
  incompleteAdditionalRepos: boolean;
}) {
  if (!selectedSource) {
    return null;
  }
  return (
    <>
      {missingRepo ? (
        <p className="text-destructive text-sm">
          No repository configured for this project. Select a repository above
          or add a default repository in project settings.
        </p>
      ) : null}
      {incompleteAdditionalRepos ? (
        <p className="text-destructive text-sm">
          Complete or remove every additional repository row before generating.
        </p>
      ) : null}
    </>
  );
}
