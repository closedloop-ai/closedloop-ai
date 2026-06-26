"use client";

import {
  useBooleanModal,
  useModalSession,
} from "@repo/app/shared/hooks/use-modal-session";

/**
 * PRD-specific modal visibility. Common chrome (delete/move/metadata panel)
 * lives in `useEditorChrome`.
 */
export function usePrdModals() {
  const rename = useBooleanModal();
  const requestChanges = useBooleanModal();
  const generatePlan = useModalSession();

  return { rename, requestChanges, generatePlan };
}
