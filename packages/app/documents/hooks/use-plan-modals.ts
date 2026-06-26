"use client";

import { useBooleanModal } from "@repo/app/shared/hooks/use-modal-session";

/**
 * Plan-specific modal visibility. Common chrome (delete/move/metadata panel)
 * lives in `useEditorChrome`.
 */
export function usePlanModals() {
  const requestChanges = useBooleanModal();
  const linearExport = useBooleanModal();
  const execute = useBooleanModal();
  const regenerate = useBooleanModal();

  return { requestChanges, linearExport, execute, regenerate };
}
