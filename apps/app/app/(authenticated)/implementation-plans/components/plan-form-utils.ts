import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
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
    type: DocumentType.ImplementationPlan,
    title: formState.title.trim(),
    fileName: finalFileName,
    approverId: selectedSource?.approver?.id,
    status: DocumentStatus.Draft,
    content: formState.content.trim() || "",
    projectId: selectedSource?.projectId ?? formState.selectedProjectId,
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

export function normalizeAdditionalRepos(
  repos: AdditionalRepoRef[]
): AdditionalRepoRef[] | undefined {
  // Defensive filter: callers should already drop placeholder rows, but
  // guard against accidental submission of { fullName: "", branch: "" }.
  const complete = repos.filter(
    ({ fullName, branch }) => fullName.length > 0 && branch.length > 0
  );
  return complete.length > 0 ? complete : undefined;
}
