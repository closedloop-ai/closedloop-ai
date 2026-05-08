"use client";

import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import { LoopCommand } from "@repo/api/src/types/loop";
import {
  getProjectSettings,
  resolveProjectRepoDefaults,
} from "@repo/api/src/types/project";
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
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useCreateAndGenerateDocument,
  useCreateDocument,
  useDocuments,
} from "@/hooks/queries/use-documents";
import { useInheritedAdditionalRepos } from "@/hooks/queries/use-loops";
import { useProject, useProjects } from "@/hooks/queries/use-projects";
import { useMultiRepoConfigEnabled } from "@/hooks/use-multi-repo-config-enabled";
import { useMultiRepoExecuteEnabled } from "@/hooks/use-multi-repo-execute-enabled";
import {
  toResolverTeamRepo,
  useTeamRepositoriesUnion,
} from "@/hooks/use-team-repositories-union";
import { PreLoopCommand } from "@/lib/system-check/pre-loop-health-check";
import { useOptionalPreLoopSystemCheckGate } from "@/lib/system-check/pre-loop-system-check-provider";
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
  showPicker: boolean;
  additionalRepos: AdditionalRepoRef[];
  createPlan: ReturnType<typeof useCreateDocument>;
  createAndGeneratePlan: ReturnType<typeof useCreateAndGenerateDocument>;
  preLoopGate: ReturnType<typeof useOptionalPreLoopSystemCheckGate>;
  preLoopOwnerKey: string;
  onSuccess: (document: { slug: string }) => void;
};

function submitCreatePlan({
  formState,
  selectedSource,
  showPicker,
  additionalRepos,
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
    selectedSource
  );

  if (createConfig.type === "createAndGenerate") {
    const submitAdditionalRepos = showPicker
      ? normalizeAdditionalRepos(additionalRepos)
      : undefined;
    const executeCreateAndGenerate = () => {
      createAndGeneratePlan.mutate(
        { input: createConfig.input, additionalRepos: submitAdditionalRepos },
        { onSuccess }
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
    executeCreateAndGenerate();
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
  const preLoopOwnerKey = `new-plan:${useId()}`;
  const preLoopGate = useOptionalPreLoopSystemCheckGate();
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

  // Fetch project details and resolve the project's primary repo (override →
  // single-team inheritance → legacy fallback) in one hook so the launch
  // dialog stays at a single integration point. When `multi-repo-config` is
  // off the resolver collapses to legacy `defaultRepository` only — team
  // repos are not even fetched.
  const multiRepoConfigEnabled = useMultiRepoConfigEnabled();
  const effectiveProjectId = source?.projectId ?? selectedProjectId;
  const { primaryRepoId, primaryFullName, missingRepo, isLoadingResolved } =
    useNewPlanRepoState({
      open,
      effectiveProjectId,
      targetRepo,
      teamReposEnabled: multiRepoConfigEnabled,
    });

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

  // Inherit additionalRepos from the source PRD's most recent loop
  const inheritedRepos = useInheritAdditionalReposFromSource({
    open,
    showPicker,
    sourceId: selectedSource?.id,
    onSeed: setAdditionalRepos,
  });
  // Mark the picker as user-edited as soon as onChange fires, so a
  // late-arriving query result does not clobber the edit.
  const onAdditionalReposChange = useCallback(
    (repos: AdditionalRepoRef[]) => {
      inheritedRepos.markUserEdited();
      setAdditionalRepos(repos);
    },
    [inheritedRepos.markUserEdited]
  );

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

  // Pre-populate from the resolved project primary when the modal opens.
  useResolvedPrimaryPrepopulation({
    open,
    sourceTargetRepo: source?.targetRepo,
    targetRepo,
    primaryRepoId,
    primaryFullName,
    isLoadingResolved,
    hasPrePopulatedRef: hasPrePopulated,
    setSelectedRepoId,
    setTargetRepo,
  });

  const handleTitleChange = (value: string): void => {
    setTitle(value);
    if (value.trim()) {
      setFileName(generateFileNameFromTitle(value));
    } else {
      setFileName("");
    }
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
      preLoopGate,
      preLoopOwnerKey,
      onSuccess: (document) => {
        setOpen(false);
        router.push(`/implementation-plans/${document.slug}`);
      },
    });
  };

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (!newOpen) {
      preLoopGate?.cancelPendingPreLoopAttempt(preLoopOwnerKey);
    }
  };

  const handleRepositoryChange = (repoId: string, fullName: string) => {
    setSelectedRepoId(repoId);
    setTargetRepo(fullName);
    setTargetBranch("");
  };

  const showProjectSelector = !selectedSource?.projectId;
  const isPreLoopPendingForThisModal = isPreLoopPendingForOwner({
    enabled: Boolean(selectedSource),
    ownerKey: preLoopOwnerKey,
    preLoopGate,
  });
  const isSubmitting =
    createPlan.isPending ||
    createAndGeneratePlan.isPending ||
    isPreLoopPendingForThisModal;

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
              // Remount once the inherited peers from PRD-244 loops resolve so
              // the picker re-seeds via `initialValue`. Without the key change
              // the picker keeps its mount-time seed (empty array) and the
              // late-arriving inherited repos would never appear.
              initialValue={additionalRepos}
              key={inheritedRepos.pickerKey}
              onChange={onAdditionalReposChange}
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

function TargetRepoBranchFields({
  targetRepo,
  selectedRepoId,
  selectedBranch,
  onRepoChange,
  onBranchChange,
}: Readonly<{
  targetRepo: string;
  selectedRepoId: string;
  selectedBranch: string;
  onRepoChange: (repoId: string, fullName: string) => void;
  onBranchChange: (branch: string) => void;
}>) {
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
}: Readonly<{
  selectedSource: PlanSource | undefined;
  missingRepo: boolean;
  incompleteAdditionalRepos: boolean;
}>) {
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

type UseInheritAdditionalReposArgs = {
  open: boolean;
  showPicker: boolean;
  sourceId: string | undefined;
  onSeed: (initial: AdditionalRepoRef[]) => void;
};

type UseInheritAdditionalReposResult = {
  pickerKey: number;
  markUserEdited: () => void;
};

// Sentinel for the seed-once guard: the source whose peers are already
// reflected in the picker. The guard re-arms automatically when `sourceId`
// changes — switching PRDs in the dropdown re-seeds from the new source
// instead of being silently blocked.
const SEED_NOT_APPLIED = Symbol("seed-not-applied");
type SeededSource = string | undefined | typeof SEED_NOT_APPLIED;

function useInheritAdditionalReposFromSource({
  open,
  showPicker,
  sourceId,
  onSeed,
}: UseInheritAdditionalReposArgs): UseInheritAdditionalReposResult {
  const [pickerKey, setPickerKey] = useState(0);
  // The sourceId whose peer set is currently reflected in the picker, or
  // the sentinel when nothing has been seeded yet. The seed effect bails
  // when this matches the live `sourceId` (already seeded for this source
  // OR the user has typed and we don't want to clobber their edit).
  const seededSourceRef = useRef<SeededSource>(SEED_NOT_APPLIED);
  // Flagging the current source as seeded prevents a late query response
  // from overwriting an edit the user made before the query resolved.
  const markUserEdited = useCallback(() => {
    seededSourceRef.current = sourceId;
  }, [sourceId]);

  const enabled = open && showPicker;
  const lookupId = enabled ? sourceId : null;
  // Target command is PLAN — the modal is launching a new PLAN loop on the
  // soon-to-be-created Plan document. The backend's PLAN precedence chain
  // resolves "GENERATE_PRD on the source PRD" for this case.
  const { data: inherited, isFetched } = useInheritedAdditionalRepos(
    lookupId,
    LoopCommand.Plan,
    { enabled: !!lookupId }
  );

  // sourceId changed since we last seeded → drop stale peers immediately
  // (don't wait for the new query) and re-arm the seed guard.
  useEffect(() => {
    const seeded = seededSourceRef.current;
    if (seeded !== SEED_NOT_APPLIED && seeded !== sourceId) {
      seededSourceRef.current = SEED_NOT_APPLIED;
      onSeed([]);
      setPickerKey((k) => k + 1);
    }
  }, [sourceId, onSeed]);

  // Seed when fresh data arrives for a source we haven't seeded yet.
  useEffect(() => {
    if (!(isFetched && inherited)) {
      return;
    }
    if (seededSourceRef.current === sourceId) {
      return;
    }
    seededSourceRef.current = sourceId;
    if (inherited.additionalRepos.length === 0) {
      return;
    }
    onSeed(inherited.additionalRepos);
    setPickerKey((k) => k + 1);
  }, [isFetched, inherited, sourceId, onSeed]);

  return { pickerKey, markUserEdited };
}

type UseResolvedPrimaryPrepopulationArgs = {
  open: boolean;
  sourceTargetRepo: string | null | undefined;
  targetRepo: string;
  primaryRepoId: string | undefined;
  primaryFullName: string | undefined;
  // True while the team-repo union is still loading. The effect must not fire
  // during this window because the resolver would otherwise return the legacy
  // `defaultRepository` fallback and `hasPrePopulatedRef` would short-circuit
  // any later correction once the override pool finishes loading (P1 review
  // finding on PR #1115).
  isLoadingResolved: boolean;
  hasPrePopulatedRef: { current: boolean };
  setSelectedRepoId: (id: string) => void;
  setTargetRepo: (name: string) => void;
};

// Pre-populates the launch dialog's primary repo from the project resolution
// chain (override → single-team inheritance → legacy fallback). Branch is left
// empty so `RepoBranchSelector` picks the GitHub default branch on its own —
// branches are never stored at team or project level (Q-002 of PLN-237). When
// the project is multi-team without an override, `primaryRepoId` is undefined
// here and the user is forced to pick — see T-3.2.
function useResolvedPrimaryPrepopulation({
  open,
  sourceTargetRepo,
  targetRepo,
  primaryRepoId,
  primaryFullName,
  isLoadingResolved,
  hasPrePopulatedRef,
  setSelectedRepoId,
  setTargetRepo,
}: UseResolvedPrimaryPrepopulationArgs): void {
  useEffect(() => {
    if (
      !open ||
      hasPrePopulatedRef.current ||
      isLoadingResolved ||
      sourceTargetRepo ||
      targetRepo ||
      !primaryRepoId ||
      !primaryFullName
    ) {
      return;
    }
    setSelectedRepoId(primaryRepoId);
    setTargetRepo(primaryFullName);
    hasPrePopulatedRef.current = true;
  }, [
    open,
    sourceTargetRepo,
    targetRepo,
    primaryRepoId,
    primaryFullName,
    isLoadingResolved,
    hasPrePopulatedRef,
    setSelectedRepoId,
    setTargetRepo,
  ]);
}

type UseResolvedProjectRepoDefaultsArgs = {
  projectData: ReturnType<typeof useProject>["data"];
  projectSettings: ReturnType<typeof getProjectSettings>;
  enabled: boolean;
};

type UseResolvedProjectRepoDefaultsResult = {
  resolved: ReturnType<typeof resolveProjectRepoDefaults>;
  primaryRepoId: string | undefined;
  primaryFullName: string | undefined;
  isLoading: boolean;
};

// Composes the resolution chain (project override → single-team inheritance
// → legacy fallback) with team-repo data fetched per project team. Returns the
// pool-resolved primary so callers can pre-populate the launch dialog without
// re-implementing the chain. The legacy `defaultRepository.repoFullName` is
// surfaced as `primaryFullName` only when the legacy id matches the resolved
// primary (pre-migration projects whose legacy repo isn't in any team pool).
type UseNewPlanRepoStateArgs = {
  open: boolean;
  effectiveProjectId: string | undefined;
  targetRepo: string;
  // Off → resolver runs without team repos, falling back to the legacy
  // `defaultRepository` only. Avoids fetching the team-repo union when the
  // multi-repo project config flag is not enabled.
  teamReposEnabled: boolean;
};

type UseNewPlanRepoStateResult = {
  primaryRepoId: string | undefined;
  primaryFullName: string | undefined;
  missingRepo: boolean;
  // Surfaces `useResolvedProjectRepoDefaults`'s loading flag (which folds in
  // the team-repo union fetch) so callers can gate the prepopulation effect
  // until the override pool has actually finished loading.
  isLoadingResolved: boolean;
};

// Wraps `useProject` + `useResolvedProjectRepoDefaults` + the launch-dialog's
// missing-repo gate so the modal body has a single integration point. Loading
// states are folded into `missingRepo` (false while loading) so the user can't
// see a transient "no repo" error before the resolver finishes.
function useNewPlanRepoState({
  open,
  effectiveProjectId,
  targetRepo,
  teamReposEnabled,
}: UseNewPlanRepoStateArgs): UseNewPlanRepoStateResult {
  const { data: projectData, isLoading: isLoadingProject } = useProject(
    effectiveProjectId ?? ""
  );
  const projectSettings = getProjectSettings(projectData?.settings ?? {});
  const {
    primaryRepoId,
    primaryFullName,
    isLoading: isLoadingResolved,
  } = useResolvedProjectRepoDefaults({
    projectData,
    projectSettings,
    enabled: open && teamReposEnabled,
  });
  const missingRepo = !(
    isLoadingProject ||
    isLoadingResolved ||
    targetRepo ||
    primaryFullName
  );
  return {
    primaryRepoId,
    primaryFullName,
    missingRepo,
    isLoadingResolved: isLoadingProject || isLoadingResolved,
  };
}

function useResolvedProjectRepoDefaults({
  projectData,
  projectSettings,
  enabled,
}: UseResolvedProjectRepoDefaultsArgs): UseResolvedProjectRepoDefaultsResult {
  const teamIds = useMemo(
    () => projectData?.teams.map((t) => t.id) ?? [],
    [projectData?.teams]
  );
  const { repositories, isLoading } = useTeamRepositoriesUnion({
    teamIds,
    enabled: enabled && teamIds.length > 0,
  });
  const resolved = useMemo(() => {
    if (!projectData) {
      return null;
    }
    return resolveProjectRepoDefaults({
      projectSettings,
      teamRepos: repositories.map(toResolverTeamRepo),
      teamCount: teamIds.length,
    });
  }, [projectData, projectSettings, repositories, teamIds.length]);

  if (!resolved) {
    return {
      resolved: null,
      primaryRepoId: undefined,
      primaryFullName: undefined,
      isLoading,
    };
  }
  const primaryFromPool = repositories.find(
    (r) => r.installationRepositoryId === resolved.primaryRepoId
  );
  const legacy = projectSettings.defaultRepository;
  const primaryFullName =
    primaryFromPool?.repository.fullName ??
    (legacy?.repoId === resolved.primaryRepoId
      ? legacy.repoFullName
      : undefined);
  return {
    resolved,
    primaryRepoId: resolved.primaryRepoId,
    primaryFullName,
    isLoading,
  };
}
