"use client";

import { useFrontendCaptureGate } from "./use-frontend-capture-gate";

/**
 * Mounts the staff-gated frontend-capture side effect (FEA-2400). Renders
 * nothing; belongs inside the authenticated tree next to `<UserIdentifier />`
 * so PostHog identity resolves before the capture flag is evaluated.
 */
export function FrontendCaptureController() {
  useFrontendCaptureGate();

  return null;
}
