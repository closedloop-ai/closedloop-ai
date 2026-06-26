/**
 * Autonomy is an integer `0–100` synced from the desktop app describing how much
 * of a session ran without human steering. The threshold boundaries live here so
 * every surface that classifies the score — the session-detail Properties panel
 * and the sessions-list "Autonomy" column — stays in sync (FEA-2094 SSOT).
 */
export type AutonomyTier = "high" | "mixed" | "guided" | "unknown";

/** Single source of truth for the autonomy threshold boundaries. */
export function getAutonomyTier(
  value: number | null | undefined
): AutonomyTier {
  if (value == null) {
    return "unknown";
  }
  if (value >= 80) {
    return "high";
  }
  if (value >= 50) {
    return "mixed";
  }
  return "guided";
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
