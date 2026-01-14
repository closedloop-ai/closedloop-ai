/**
 * Discriminated union for server action responses
 * Use this for all server actions to ensure consistent error handling
 */
export type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

/**
 * Helper to create a success result
 */
export function success<T>(data: T): ActionResult<T> {
  return { success: true, data };
}

/**
 * Helper to create an error result
 */
export function failure(error: string): ActionResult<never> {
  return { success: false, error };
}

// =============================================================================
// PRD Types
// =============================================================================

export const PRD_STATUS_OPTIONS = [
  "Draft",
  "Review",
  "Approved",
  "Archived",
] as const;
export type PRDStatus = (typeof PRD_STATUS_OPTIONS)[number];

export const PRD_TEMPLATE_OPTIONS = [
  "Standard PRD",
  "Feature Brief",
  "Bug Fix",
  "Technical Spec",
] as const;
export type PRDTemplate = (typeof PRD_TEMPLATE_OPTIONS)[number];

// =============================================================================
// Implementation Plan Types
// =============================================================================

export const IMPL_PLAN_STATUS_OPTIONS = [
  "Draft",
  "Ready",
  "In Progress",
  "Generating",
  "Failed",
  "Archived",
] as const;
export type ImplPlanStatus = (typeof IMPL_PLAN_STATUS_OPTIONS)[number];

export const IMPL_PLAN_TYPE_OPTIONS = [
  "Standard",
  "Quick",
  "Detailed",
  "Technical",
] as const;
export type ImplPlanType = (typeof IMPL_PLAN_TYPE_OPTIONS)[number];

// =============================================================================
// Shared Entity Types
// =============================================================================

import type { ImplementationPlan, PRD } from "@repo/database/generated/client";

export type ImplementationPlanWithPRD = ImplementationPlan & {
  sourcePrd: Pick<PRD, "id" | "title">;
};
