import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import { useState } from "react";
import type { JobRepoSelection } from "@/app/(authenticated)/components/job-repositories/selection";
import type { PlanSource } from "./plan-source";

export type FormState = {
  selectedSourceId: string;
  selectedProjectId: string;
  title: string;
  fileName: string;
  content: string;
};

export function buildCreateInput(
  formState: FormState,
  finalFileName: string,
  selectedSource: PlanSource | undefined,
  jobRepos?: JobRepoSelection | null
) {
  // PLN-602: the plan's `repositorySnapshot` is server-owned, but when the
  // user picked repos in the modal we forward them as `repositorySelection`
  // so the server emits a `loop_selection` snapshot with all selected repos.
  // When no `jobRepos` is provided, the server falls back to source
  // inheritance (via `sourceId`) or project defaults.
  const repositorySelection = jobRepos
    ? {
        primary: {
          fullName: jobRepos.primary.fullName,
          branch: jobRepos.primary.branch,
        },
        ...(jobRepos.additional.length > 0
          ? { additional: jobRepos.additional }
          : {}),
      }
    : undefined;
  const baseInput = {
    type: DocumentType.ImplementationPlan,
    title: formState.title.trim(),
    fileName: finalFileName,
    approverId: selectedSource?.approver?.id,
    status: DocumentStatus.Draft,
    content: formState.content.trim() || "",
    projectId: selectedSource?.projectId ?? formState.selectedProjectId,
    ...(repositorySelection ? { repositorySelection } : {}),
  };

  if (!selectedSource) {
    return { type: "create" as const, input: baseInput };
  }

  return {
    type: "createAndGenerate" as const,
    input: {
      ...baseInput,
      sourceId: selectedSource.id,
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
