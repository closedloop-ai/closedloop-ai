"use client";

import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import { usePRDEditor as usePRDEditorImpl } from "@/hooks/use-artifact-editor";

/**
 * Hook for PRD editor functionality.
 * Re-exports the shared implementation from hooks/use-artifact-editor.
 */
export function usePRDEditor(prd: ArtifactWithWorkstream) {
  return usePRDEditorImpl(prd);
}
