"use client";

import type { Document } from "@repo/api/src/types/document";
import { useProjects } from "@repo/app/projects/hooks/use-projects";
import { getErrorMessage } from "@repo/app/shared/api/api-error";
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
import { LoaderIcon, SparklesIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { GeneratePrdTargetSelector } from "@/app/(authenticated)/[orgSlug]/documents/components/generate-prd-target-selector";
import { useGeneratePrdFromDocument } from "@/hooks/queries/use-document-generation";
import {
  PreLoopCommand,
  type PreLoopExecutionContext,
  resolvePreLoopComputeTargetId,
} from "@/lib/system-check/pre-loop-health-check";
import { useOptionalPreLoopSystemCheckGate } from "@/lib/system-check/pre-loop-system-check-provider";

type GeneratePrdFromDocumentDialogProps = {
  /** Source evergreen Document (DocumentType.Doc) the PRD is generated from. */
  document: Pick<Document, "id" | "title">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Project the row lives in, when the dialog is opened from a project-scoped
   * surface. Pre-selects (but does not lock) the target project so the user
   * doesn't have to re-state context the screen already has.
   */
  defaultProjectId?: string;
  onSuccess?: (prd: Document) => void;
};

/**
 * Turn an evergreen Document into a DRAFT PRD via the existing GENERATE_PRD
 * engine (FEA-3952). Evergreen docs are project-less, so the target project is
 * chosen here before generation; the server seeds the PRD with this Document's
 * content and writes the RelatesTo provenance link.
 *
 * The seed and the launch are two separate writes handled by the hook. When the
 * launch conflicts on compute target, the seeded PRD is already committed and
 * only the launch is replayed via `selectTarget` — the project and title fields
 * lock at that point since the artifact exists and can no longer be re-shaped.
 */
export function GeneratePrdFromDocumentDialog({
  document,
  open,
  onOpenChange,
  defaultProjectId,
  onSuccess,
}: Readonly<GeneratePrdFromDocumentDialogProps>) {
  const projectSelectId = useId();
  const titleInputId = useId();
  const preLoopOwnerKey = `generate-prd-from-doc:${useId()}`;
  const preLoopGate = useOptionalPreLoopSystemCheckGate();
  const [selectedProjectId, setSelectedProjectId] = useState(
    defaultProjectId ?? ""
  );
  const [title, setTitle] = useState(() => seededPrdTitle(document.title));

  const {
    data: projects = [],
    isLoading: isLoadingProjects,
    isError: isProjectsError,
    error: projectsError,
  } = useProjects(undefined, { enabled: open });
  const generate = useGeneratePrdFromDocument();
  const { multiTargetState, selectTarget, clearTargetSelection } = generate;

  // Reset local state whenever the dialog reopens for a (possibly different)
  // Document so a prior selection never leaks across invocations.
  useEffect(() => {
    if (open) {
      setSelectedProjectId(defaultProjectId ?? "");
      setTitle(seededPrdTitle(document.title));
      clearTargetSelection();
    }
  }, [open, document.title, defaultProjectId, clearTargetSelection]);

  const isSubmitting =
    generate.isPending ||
    Boolean(preLoopGate?.pendingOwnerKey === preLoopOwnerKey);
  // Once the seed PRD exists (target selection is pending), the project and
  // title can no longer change — they're baked into the committed artifact.
  const isTargetSelectionPending = Boolean(multiTargetState);
  const canGenerate =
    Boolean(selectedProjectId) && !isSubmitting && !isTargetSelectionPending;

  const handleClose = () => {
    preLoopGate?.cancelPendingPreLoopAttempt(preLoopOwnerKey);
    onOpenChange(false);
  };

  const handleGenerate = () => {
    if (!selectedProjectId) {
      return;
    }
    const trimmedTitle = title.trim();
    const execute = (context: PreLoopExecutionContext) => {
      generate.mutate(
        {
          documentId: document.id,
          projectId: selectedProjectId,
          ...(trimmedTitle ? { title: trimmedTitle } : {}),
          // An explicit `null` is the gate's "run this on Cloud" verdict and
          // must survive; only an absent value leaves the choice to the server.
          ...(context.computeTargetId === undefined
            ? {}
            : { computeTargetId: context.computeTargetId }),
        },
        {
          onSuccess: (result) => {
            if (result.status === "pending_target_selection") {
              return;
            }
            handleClose();
            onSuccess?.(result.artifact);
          },
        }
      );
    };

    if (preLoopGate) {
      preLoopGate
        .runWithPreLoopSystemCheck(
          {
            command: PreLoopCommand.GeneratePrd,
            documentType: "prd",
            ownerKey: preLoopOwnerKey,
          },
          execute
        )
        .catch(() => undefined);
      return;
    }
    execute({});
  };

  const handleTargetSelect = (computeTargetId: string) => {
    const execute = async (context: PreLoopExecutionContext) => {
      // `??` would collapse the gate's explicit `null` — its "run this on
      // Cloud" verdict — back onto the target we just failed to reach.
      const result = await selectTarget(
        resolvePreLoopComputeTargetId(context, computeTargetId)
      );
      if (result?.status === "launched") {
        handleClose();
        onSuccess?.(result.artifact);
      }
    };

    if (preLoopGate) {
      preLoopGate
        .runWithPreLoopSystemCheck(
          {
            command: PreLoopCommand.GeneratePrd,
            computeTargetId,
            documentType: "prd",
            ownerKey: preLoopOwnerKey,
          },
          execute
        )
        .catch(() => undefined);
      return;
    }
    execute({ computeTargetId }).catch(() => undefined);
  };

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          onOpenChange(true);
        } else {
          handleClose();
        }
      }}
      open={open}
    >
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Generate PRD</DialogTitle>
          <DialogDescription>
            {isTargetSelectionPending
              ? `The draft PRD from "${document.title}" was created and just needs a machine to run on.`
              : `Turn "${document.title}" into a draft PRD. Pick the project the new PRD will live in.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <GeneratePrdTargetSelector
            onSelect={handleTargetSelect}
            state={multiTargetState}
          />

          {isProjectsError ? (
            <Alert variant="error">
              <AlertDescription>
                {getErrorMessage(projectsError) ||
                  "Couldn't load projects. Try again."}
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-2">
            <Label
              className="font-normal text-muted-foreground text-xs"
              htmlFor={projectSelectId}
            >
              Project<span className="text-destructive">*</span>
            </Label>
            <Select
              disabled={isLoadingProjects || isTargetSelectionPending}
              onValueChange={setSelectedProjectId}
              value={selectedProjectId}
            >
              <SelectTrigger
                aria-label="Select target project"
                id={projectSelectId}
              >
                <SelectValue
                  placeholder={
                    isLoadingProjects
                      ? "Loading projects..."
                      : "Select a project..."
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {projects.length === 0 ? (
                  <SelectItem disabled value="no-projects">
                    {isProjectsError
                      ? "Couldn't load projects"
                      : "No projects available"}
                  </SelectItem>
                ) : (
                  projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label
              className="font-normal text-muted-foreground text-xs"
              htmlFor={titleInputId}
            >
              PRD title
            </Label>
            <Input
              disabled={isTargetSelectionPending}
              id={titleInputId}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Enter a title for the generated PRD"
              value={title}
            />
          </div>
        </div>

        <DialogFooter>
          <Button onClick={handleClose} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={!canGenerate}
            onClick={handleGenerate}
            type="button"
          >
            {isSubmitting ? (
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Seed the PRD title as "PRD: <document title>" so the derived artifact reads as
 * derived at a glance instead of colliding verbatim with the source Document
 * (mirrors new-plan-modal's "Plan: <source title>"). Avoids double-prefixing if
 * the source already carries the prefix.
 */
const PRD_TITLE_PREFIX = /^prd:\s/i;

function seededPrdTitle(sourceTitle: string): string {
  const trimmed = sourceTitle.trim();
  if (PRD_TITLE_PREFIX.test(trimmed)) {
    return trimmed;
  }
  return `PRD: ${trimmed}`;
}
