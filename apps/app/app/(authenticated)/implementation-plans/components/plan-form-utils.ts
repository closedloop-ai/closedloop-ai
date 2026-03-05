import { ArtifactStatus, ArtifactType } from "@repo/api/src/types/artifact";
import { useState } from "react";
import type { PlanSource } from "./plan-source";

export type FormState = {
  selectedSourceId: string;
  selectedProjectId: string;
  title: string;
  fileName: string;
  content: string;
  targetRepo: string;
  targetBranch: string;
};

export function buildCreateInput(
  formState: FormState,
  finalFileName: string,
  selectedSource: PlanSource | undefined
) {
  const baseInput = {
    type: ArtifactType.ImplementationPlan,
    title: formState.title.trim(),
    fileName: finalFileName,
    approverId: selectedSource?.approver?.id,
    status: ArtifactStatus.Draft,
    content: formState.content.trim() || "",
    projectId:
      selectedSource?.projectId ?? (formState.selectedProjectId || undefined),
    targetRepo: formState.targetRepo || undefined,
    targetBranch: formState.targetBranch || undefined,
  };

  if (!selectedSource) {
    return { type: "create" as const, input: baseInput };
  }

  return {
    type: "createAndGenerate" as const,
    input: {
      ...baseInput,
      sourceId: selectedSource.id,
      sourceType: selectedSource.sourceType,
      sourceVersion: selectedSource.latestVersion,
      workstreamId: selectedSource.workstreamId ?? undefined,
    },
  };
}

export function useModalOpenState(
  controlledOpen?: boolean,
  controlledOnOpenChange?: (open: boolean) => void
) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = controlledOnOpenChange ?? setInternalOpen;
  return { open, setOpen, isControlled };
}
