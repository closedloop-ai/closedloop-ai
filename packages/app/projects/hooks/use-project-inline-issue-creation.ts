"use client";

import type { CreateDocumentInput } from "@repo/api/src/types/document";
import type { ProjectTreeDetailsResponse } from "@repo/api/src/types/project-tree";
import { useRef } from "react";
import { useCreateDocument } from "../../documents/hooks/use-documents";

/** Retain the created identity if its subsequent placement needs a retry. */
export function useProjectInlineIssueCreation() {
  const create = useCreateDocument();
  const pending = useRef(new Map<string, string>());
  return async ({
    input,
    groupKey,
    afterId,
    refresh,
    place,
    advance,
  }: {
    input: CreateDocumentInput;
    groupKey?: string;
    afterId?: string;
    refresh: () => Promise<ProjectTreeDetailsResponse | undefined>;
    place: (
      id: string,
      afterId: string,
      projectVersion: string
    ) => Promise<unknown>;
    advance: (id: string) => void;
  }) => {
    const draftKey = JSON.stringify([
      input.projectId,
      input.title,
      groupKey,
      afterId,
    ]);
    let id = pending.current.get(draftKey);
    if (!id) {
      const created = await create.mutateAsync(input);
      id = created.id;
      pending.current.set(draftKey, id);
    }
    if (afterId) {
      const refreshed = await refresh();
      if (!refreshed?.projectVersion) {
        throw new Error("Project version unavailable");
      }
      await place(id, afterId, refreshed.projectVersion);
    }
    pending.current.delete(draftKey);
    advance(id);
  };
}
