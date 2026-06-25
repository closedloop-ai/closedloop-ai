"use client";

import {
  useBooleanModal,
  useModalSession,
} from "@repo/app/shared/hooks/use-modal-session";

/**
 * Feature-specific modal visibility. Common chrome (delete/move/metadata
 * panel) lives in `useEditorChrome`.
 */
export function useFeatureModals() {
  const generatePlan = useModalSession();
  const execute = useBooleanModal();

  return { generatePlan, execute };
}
