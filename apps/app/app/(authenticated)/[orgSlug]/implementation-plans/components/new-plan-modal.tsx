"use client";

import {
  type DocumentWithProject,
  getPrimaryRepoFromSnapshot,
} from "@repo/api/src/types/document";
import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import { LoopCommand } from "@repo/api/src/types/loop";
import {
  useCreateDocument,
  useDocuments,
} from "@repo/app/documents/hooks/use-documents";
import { useResolvedJobRepos } from "@repo/app/loops/hooks/use-resolved-job-repos";
import { useProjects } from "@repo/app/projects/hooks/use-projects";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
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
import { useNavigation } from "@repo/navigation/use-navigation";
import { LoaderIcon, PlusIcon, SparklesIcon } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { JobRepositoriesSection } from "@/app/(authenticated)/components/job-repositories-section";
import { LoopDispatchTargetSelector } from "@/components/engineer/LoopDispatchTargetSelector";
import { useCreateAndGenerateDocument } from "@/hooks/queries/use-document-generation";
import { useOrgSlug } from "@/hooks/use-org-slug";
import {
  PreLoopCommand,
  type PreLoopExecutionContext,
} from "@/lib/system-check/pre-loop-health-check";
import { useOptionalPreLoopSystemCheckGate } from "@/lib/system-check/pre-loop-system-check-provider";
import type { JobRepoSelection } from "../../../components/job-repositories/selection";
import { PlanPreview, PrdSelector, ProjectSelector } from "./plan-form-fields";
import {
  buildCreateInput,
  type FormState,
  useModalOpenState,
} from "./plan-form-utils";
import {
  generateFileNameFromTitle,
  generatePlanFileName,
  getFinalFileName,
  type PlanSource,
} from "./plan-source";

type NewPlanModalProps = {
  source?: PlanSource;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

function isCreateSubmitDisabled(
  isSubmitting: boolean,
  titleTrimmed: boolean,
  selectedSource: PlanSource | undefined,
  reposIncomplete: boolean
): boolean {
  return isSubmitting || !titleTrimmed || (!!selectedSource && reposIncomplete);
}

function isPreLoopPendingForOwner({
  enabled,
  ownerKey,
  preLoopGate,
}: {
  enabled: boolean;
  ownerKey: string;
  preLoopGate: ReturnType<typeof useOptionalPreLoopSystemCheckGate>;
}): boolean {
  return Boolean(enabled && preLoopGate?.pendingOwnerKey === ownerKey);
}

type SubmitCreatePlanArgs = {
  formState: FormState;
  selectedSource: PlanSource | undefined;
  jobRepos: JobRepoSelection | null;
  createPlan: ReturnType<typeof useCreateDocument>;
  createAndGeneratePlan: ReturnType<typeof useCreateAndGenerateDocument>;
  preLoopGate: ReturnType<typeof useOptionalPreLoopSystemCheckGate>;
  preLoopOwnerKey: string;
  onSuccess: (document: { slug: string }) => void;
};

function submitCreatePlan({
  formState,
  selectedSource,
  jobRepos,
  createPlan,
  createAndGeneratePlan,
  preLoopGate,
  preLoopOwnerKey,
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
    selectedSource,
    jobRepos
  );

  if (createConfig.type === "createAndGenerate") {
    const submitAdditionalRepos: AdditionalRepoRef[] | undefined =
      jobRepos && jobRepos.additional.length > 0
        ? jobRepos.additional
        : undefined;
    const executeCreateAndGenerate = (context: PreLoopExecutionContext) => {
      createAndGeneratePlan.mutate(
        {
          input: createConfig.input,
          additionalRepos: submitAdditionalRepos,
          computeTargetId: context.computeTargetId,
        },
        {
          onSuccess: (result) => {
            if (result.status === "launched") {
              onSuccess(result.artifact);
            }
          },
        }
      );
    };
    if (preLoopGate) {
      preLoopGate
        .runWithPreLoopSystemCheck(
          {
            command: PreLoopCommand.GeneratePlan,
            documentType: "implementation_plan",
            ownerKey: preLoopOwnerKey,
          },
          executeCreateAndGenerate
        )
        .catch(() => undefined);
      return;
    }
    executeCreateAndGenerate({});
    return;
  }
  createPlan.mutate(createConfig.input, { onSuccess });
}

type FormFields = {
  selectedSourceId: string;
  setSelectedSourceId: (v: string) => void;
  selectedProjectId: string;
  setSelectedProjectId: (v: string) => void;
  title: string;
  setTitle: (v: string) => void;
  fileName: string;
  setFileName: (v: string) => void;
  content: string;
  setContent: (v: string) => void;
  jobRepos: JobRepoSelection | null;
  setJobRepos: (v: JobRepoSelection | null) => void;
  reposIncomplete: boolean;
  setReposIncomplete: (v: boolean) => void;
};

function useNewPlanFormFields(source: PlanSource | undefined): FormFields {
  const [selectedSourceId, setSelectedSourceId] = useState(source?.id ?? "");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [title, setTitle] = useState(() =>
    source ? `Plan: ${source.title}` : ""
  );
  const [fileName, setFileName] = useState(() =>
    source ? generatePlanFileName(source) : ""
  );
  const [content, setContent] = useState("");
  const [jobRepos, setJobRepos] = useState<JobRepoSelection | null>(null);
  const [reposIncomplete, setReposIncomplete] = useState(false);
  return {
    selectedSourceId,
    setSelectedSourceId,
    selectedProjectId,
    setSelectedProjectId,
    title,
    setTitle,
    fileName,
    setFileName,
    content,
    setContent,
    jobRepos,
    setJobRepos,
    reposIncomplete,
    setReposIncomplete,
  };
}

export function NewPlanModal({
  source,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: NewPlanModalProps = {}) {
  const navigation = useNavigation();
  const orgSlug = useOrgSlug();
  const preLoopOwnerKey = `new-plan:${useId()}`;
  const preLoopGate = useOptionalPreLoopSystemCheckGate();
  const createPlan = useCreateDocument();
  const createAndGeneratePlan = useCreateAndGenerateDocument();
  const { open, setOpen, isControlled } = useModalOpenState(
    controlledOpen,
    controlledOnOpenChange
  );
  const [error, setError] = useState<string | null>(null);
  const fields = useNewPlanFormFields(source);
  const seededSourceIdRef = useRef<string | null>(null);

  const { data: prds = [], isLoading: loadingPrds } = useDocuments(
    { type: "PRD", projectId: fields.selectedProjectId },
    {
      enabled: open && !!fields.selectedProjectId && !source,
    }
  );

  const { data: projects = [], isLoading: loadingProjects } = useProjects(
    undefined,
    { enabled: open }
  );

  const selectedPrd = prds.find((p) => p.id === fields.selectedSourceId);
  const selectedSource: PlanSource | undefined = useMemo(
    () => source ?? selectedPrd ?? undefined,
    [source, selectedPrd]
  );

  // Effective project id for resolving the team-repo pool. The hooks are
  // gated by `enabled: open` so the team-repo + branch fetches only fire
  // while the dialog is on screen.
  const effectiveProjectId = source?.projectId ?? fields.selectedProjectId;
  const resolvedJobRepos = useResolvedJobRepos({
    projectId: effectiveProjectId,
    artifactId: selectedSource?.id,
    command: LoopCommand.Plan,
    // Seed with the source artifact's primary repo from its immutable
    // snapshot (PLN-602). The hook still prefers prior-Loop repos when
    // available; this is the second step before falling back to project
    // defaults.
    primaryFullNameSeed: selectedSource?.repositorySnapshot
      ? (getPrimaryRepoFromSnapshot(selectedSource.repositorySnapshot)
          ?.fullName ?? null)
      : null,
    enabled: open,
  });

  syncTitleFromSource(fields, source, selectedSource, seededSourceIdRef);

  const handleTitleChange = (value: string): void => {
    fields.setTitle(value);
    fields.setFileName(value.trim() ? generateFileNameFromTitle(value) : "");
  };

  const handleSubmit = () => {
    setError(null);
    if (!fields.title.trim()) {
      setError("Please enter a title");
      return;
    }
    submitCreatePlan({
      formState: buildFormState(fields),
      selectedSource,
      jobRepos: fields.jobRepos,
      createPlan,
      createAndGeneratePlan,
      preLoopGate,
      preLoopOwnerKey,
      onSuccess: (document) => {
        setOpen(false);
        navigation.navigate(
          `/${orgSlug}/implementation-plans/${document.slug}`
        );
      },
    });
  };

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (!newOpen) {
      preLoopGate?.cancelPendingPreLoopAttempt(preLoopOwnerKey);
      createAndGeneratePlan.clearTargetSelection();
    }
  };

  const handlePostCreateTargetSelect = async (targetId: string) => {
    const executeSelectTarget = async () => {
      const result = await createAndGeneratePlan.selectTarget(targetId);
      if (result?.status === "launched") {
        setOpen(false);
        navigation.navigate(
          `/${orgSlug}/implementation-plans/${result.artifact.slug}`
        );
      }
    };
    if (preLoopGate) {
      await preLoopGate.runWithPreLoopSystemCheck(
        {
          command: PreLoopCommand.GeneratePlan,
          computeTargetId: targetId,
          documentType: "implementation_plan",
          ownerKey: preLoopOwnerKey,
        },
        () => {
          executeSelectTarget().catch(() => undefined);
        }
      );
      return;
    }
    await executeSelectTarget();
  };

  const isPreLoopPendingForThisModal = isPreLoopPendingForOwner({
    enabled: Boolean(selectedSource),
    ownerKey: preLoopOwnerKey,
    preLoopGate,
  });
  const isSubmitting =
    createPlan.isPending ||
    createAndGeneratePlan.isPending ||
    isPreLoopPendingForThisModal;
  const isTargetSelectionPending = Boolean(
    createAndGeneratePlan.multiTargetState
  );

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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[500px]">
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

        <NewPlanModalBody
          error={error}
          fields={fields}
          loadingPrds={loadingPrds}
          loadingProjects={loadingProjects}
          multiTargetState={createAndGeneratePlan.multiTargetState}
          onPostCreateTargetSelect={handlePostCreateTargetSelect}
          onTitleChange={handleTitleChange}
          prds={prds}
          projects={projects}
          resolvedJobRepos={resolvedJobRepos}
          selectedSource={selectedSource}
          source={source}
        />

        <DialogFooter>
          <Button onClick={() => handleOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={isCreateSubmitDisabled(
              isSubmitting || isTargetSelectionPending,
              fields.title.trim().length > 0,
              selectedSource,
              fields.reposIncomplete
            )}
            onClick={handleSubmit}
          >
            {isSubmitting ? (
              <>
                <LoaderIcon className="h-4 w-4 animate-spin" />
                {isPreLoopPendingForThisModal ? "Checking..." : "Creating..."}
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

function buildFormState(fields: FormFields): FormState {
  return {
    selectedSourceId: fields.selectedSourceId,
    selectedProjectId: fields.selectedProjectId,
    title: fields.title,
    fileName: fields.fileName,
    content: fields.content,
  };
}

// Render-time sync: when a PRD is picked from the dropdown after the modal
// opened, prime the title/filename from it. Skips when the modal opened with
// a `source` prop (already pre-filled in initial state). The ref tracks the
// last seeded source id so we only seed once per selection — otherwise a user
// who clears the title would have it re-seeded on the next render.
function syncTitleFromSource(
  fields: FormFields,
  source: PlanSource | undefined,
  selectedSource: PlanSource | undefined,
  seededSourceIdRef: React.RefObject<string | null>
): void {
  if (!selectedSource || source) {
    return;
  }
  if (seededSourceIdRef.current === selectedSource.id) {
    return;
  }
  seededSourceIdRef.current = selectedSource.id;
  fields.setTitle(`Plan: ${selectedSource.title}`);
  fields.setFileName(generatePlanFileName(selectedSource));
}

type CreateAndGenerateReturn = ReturnType<typeof useCreateAndGenerateDocument>;
type MultiTargetState = CreateAndGenerateReturn["multiTargetState"];

type NewPlanModalBodyProps = {
  error: string | null;
  fields: FormFields;
  loadingPrds: boolean;
  loadingProjects: boolean;
  multiTargetState: MultiTargetState;
  onPostCreateTargetSelect: (targetId: string) => Promise<void>;
  onTitleChange: (value: string) => void;
  prds: DocumentWithProject[];
  projects: Array<{ id: string; name: string }>;
  resolvedJobRepos: ReturnType<typeof useResolvedJobRepos>;
  selectedSource: PlanSource | undefined;
  source: PlanSource | undefined;
};

function NewPlanModalBody({
  error,
  fields,
  loadingPrds,
  loadingProjects,
  multiTargetState,
  onPostCreateTargetSelect,
  onTitleChange,
  prds,
  projects,
  resolvedJobRepos,
  selectedSource,
  source,
}: Readonly<NewPlanModalBodyProps>) {
  const showProjectSelector = !selectedSource?.projectId;
  const sourcePrimary = selectedSource?.repositorySnapshot
    ? getPrimaryRepoFromSnapshot(selectedSource.repositorySnapshot)
    : null;

  return (
    <div className="space-y-4 py-4">
      {error ? (
        <Alert id="title-error" variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="new-title">
          Title<span className="text-destructive">*</span>
        </Label>
        <Input
          aria-describedby={error ? "title-error" : ""}
          aria-invalid={error ? "true" : "false"}
          id="new-title"
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder="Plan: Dashboard Redesign"
          value={fields.title}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="new-filename">File name</Label>
        <Input
          id="new-filename"
          onChange={(e) => fields.setFileName(e.target.value)}
          placeholder={fields.fileName}
          value={fields.fileName}
        />
      </div>

      <SourceField
        loadingPrds={loadingPrds}
        onSelect={fields.setSelectedSourceId}
        prds={prds}
        selectedSourceId={fields.selectedSourceId}
        source={source}
      />

      {showProjectSelector ? (
        <div className="space-y-2">
          <Label htmlFor="project">
            Project <span className="text-muted-foreground">(optional)</span>
          </Label>
          <ProjectSelector
            isLoading={loadingProjects}
            onSelect={fields.setSelectedProjectId}
            projects={projects}
            selectedProjectId={fields.selectedProjectId}
          />
        </div>
      ) : null}

      {selectedSource ? (
        <JobRepositoriesSection
          collapseWhenSingleRepo={false}
          onChange={fields.setJobRepos}
          onIncompleteChange={fields.setReposIncomplete}
          resolved={resolvedJobRepos}
        />
      ) : null}

      {selectedSource && sourcePrimary && (
        <PlanPreview
          fileName={fields.fileName}
          source={selectedSource}
          targetBranch={
            fields.jobRepos?.primary.branch ?? sourcePrimary?.branch ?? ""
          }
          targetRepo={
            fields.jobRepos?.primary.fullName ?? sourcePrimary?.fullName ?? ""
          }
          title={fields.title}
        />
      )}

      <div className="space-y-2">
        <Label htmlFor="new-content">Additional context</Label>
        <Textarea
          className="min-h-[75px] font-mono text-sm"
          id="new-content"
          onChange={(e) => fields.setContent(e.target.value)}
          value={fields.content}
        />
      </div>

      <PlanSubmitValidationMessages
        reposIncomplete={fields.reposIncomplete}
        selectedSource={selectedSource}
      />

      {multiTargetState ? (
        <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 p-3">
          <p className="text-muted-foreground text-sm">
            Select a compute target to start generation.
          </p>
          <LoopDispatchTargetSelector
            availableTargets={multiTargetState.availableTargets}
            onSelect={(targetId) => {
              onPostCreateTargetSelect(targetId).catch(() => undefined);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

type SourceFieldProps = {
  loadingPrds: boolean;
  onSelect: (id: string) => void;
  prds: DocumentWithProject[];
  selectedSourceId: string;
  source: PlanSource | undefined;
};

function SourceField({
  loadingPrds,
  onSelect,
  prds,
  selectedSourceId,
  source,
}: Readonly<SourceFieldProps>) {
  return (
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
          onSelect={onSelect}
          prds={prds}
          selectedPrdId={selectedSourceId}
        />
      )}
    </div>
  );
}

function PlanSubmitValidationMessages({
  selectedSource,
  reposIncomplete,
}: Readonly<{
  selectedSource: PlanSource | undefined;
  reposIncomplete: boolean;
}>) {
  if (!(selectedSource && reposIncomplete)) {
    return null;
  }
  return (
    <p className="text-destructive text-sm">
      Pick at least one repository (with a primary) before generating.
    </p>
  );
}
