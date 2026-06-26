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
  { value: 0, tier: "guided", label: "Guided autonomy", shortLabel: "Guided" },
  { value: 49, tier: "guided", label: "Guided autonomy", shortLabel: "Guided" },
  { value: 50, tier: "mixed", label: "Mixed autonomy", shortLabel: "Mixed" },
  { value: 79, tier: "mixed", label: "Mixed autonomy", shortLabel: "Mixed" },
  { value: 80, tier: "high", label: "High autonomy", shortLabel: "High" },
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
