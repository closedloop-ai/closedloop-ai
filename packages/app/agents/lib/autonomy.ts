/**
 * Autonomy is an integer `0–100` synced from the desktop app describing how much
 * of a session ran without human steering. The threshold boundaries and the
 * classifier are the runtime-agnostic SSOT in `@repo/api/src/agent-session-filters`
 * (FEA-2094) so every surface that classifies the score — the session-detail
 * Properties panel, the sessions-list "Autonomy" column, and the Autonomy filter
 * facet — stays in sync. This module re-exports the UI-facing label helpers.
 */
import {
  type AutonomyTier,
  classifyAutonomyTier,
} from "@repo/api/src/agent-session-filters";

export type { AutonomyTier } from "@repo/api/src/agent-session-filters";

/** Single source of truth for the autonomy threshold boundaries. */
export function getAutonomyTier(
  value: number | null | undefined
): AutonomyTier {
  return classifyAutonomyTier(value);
}

const AUTONOMY_TIER_WORD: Record<AutonomyTier, string> = {
  high: "High",
  mixed: "Mixed",
  guided: "Guided",
  unknown: "Unknown",
};

/** Full label for the detail Properties panel, e.g. `"High autonomy"`. */
export function getAutonomyLabel(value: number | null | undefined): string {
  return `${AUTONOMY_TIER_WORD[getAutonomyTier(value)]} autonomy`;
}

/** Compact label for the dense sessions-list column, e.g. `"High"`. */
export function getAutonomyShortLabel(
  value: number | null | undefined
): string {
  return AUTONOMY_TIER_WORD[getAutonomyTier(value)];
}
