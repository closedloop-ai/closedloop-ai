"use client";

import { useFrontendCaptureGate } from "./use-frontend-capture-gate";

/**
 * Mounts flag-gated PostHog replay for signed-in users while keeping Datadog
 * enhanced capture staff-only (FEA-2400, ISS-10650). Renders nothing; belongs
 * inside the authenticated tree next to `<UserIdentifier />` so PostHog
 * identity resolves before the capture flag is evaluated.
 */
export function FrontendCaptureController() {
  useFrontendCaptureGate();

  return null;
}
