"use client";

import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import { usePlanEditor as usePlanEditorImpl } from "@/hooks/use-artifact-editor";

/**
 * Hook for Implementation Plan editor functionality.
 * Re-exports the shared implementation from hooks/use-artifact-editor.
 */
export function usePlanEditor(plan: ArtifactWithWorkstream) {
  return usePlanEditorImpl(plan);
}
