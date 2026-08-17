import { describe, expect, it } from "vitest";
import {
  type AutonomyTier,
  getAutonomyLabel,
  getAutonomyShortLabel,
  getAutonomyTier,
} from "../autonomy";

// SSOT for the autonomy thresholds (FEA-2094). Both the sessions list and the
// session-detail Properties panel derive their display from these functions, so
// exercising the boundaries here covers every surface.
type Case = {
  value: number | null | undefined;
  tier: AutonomyTier;
  label: string;
  shortLabel: string;
};

const cases: Case[] = [
  {
    value: null,
    tier: "unknown",
    label: "Unknown autonomy",
    shortLabel: "Unknown",
  },
  {
    value: undefined,
    tier: "unknown",
    label: "Unknown autonomy",
    shortLabel: "Unknown",
  },
  // FEA-3781: boundaries recalibrated to 70/35 against the distribution the
  // attended-time score actually produces. 88/70 left "mixed" empty on the real
  // corpus — the same dead-tier defect FEA-3266 had fixed one tier over. See
  // AUTONOMY_TIER_MIN_SCORE for the measured sweep.
  { value: 0, tier: "guided", label: "Guided autonomy", shortLabel: "Guided" },
  { value: 34, tier: "guided", label: "Guided autonomy", shortLabel: "Guided" },
  { value: 35, tier: "mixed", label: "Mixed autonomy", shortLabel: "Mixed" },
  { value: 50, tier: "mixed", label: "Mixed autonomy", shortLabel: "Mixed" },
  { value: 69, tier: "mixed", label: "Mixed autonomy", shortLabel: "Mixed" },
  { value: 70, tier: "high", label: "High autonomy", shortLabel: "High" },
  { value: 100, tier: "high", label: "High autonomy", shortLabel: "High" },
];

describe("autonomy classification", () => {
  it.each(cases)("value $value → $tier", ({
    value,
    tier,
    label,
    shortLabel,
  }) => {
    expect(getAutonomyTier(value)).toBe(tier);
    expect(getAutonomyLabel(value)).toBe(label);
    expect(getAutonomyShortLabel(value)).toBe(shortLabel);
  });
});
