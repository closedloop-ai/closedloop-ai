/**
 * Display metadata for a distribution mode in the admin "Packs you distribute"
 * table (FEA-4088). The raw `DistributionMode` values (`auto_install` /
 * `opt_in`) are jargon; this maps each to the admin-facing label, a plain-words
 * gloss (shown as a tooltip so the mode cell stays one line), and an icon so
 * the signal never rests on color alone.
 *
 * An exhaustive `Record<DistributionMode, …>` so a newly added mode fails
 * typecheck here until it is intentionally given a label.
 */

import { DistributionMode } from "@repo/api/src/types/distribution";
import { BuildingIcon, type LucideIcon, PinIcon } from "lucide-react";

export type DistributionModeMeta = {
  /** Short admin-facing label ("Required" / "Offered"). */
  label: string;
  /** Plain-words gloss shown as the mode cell's tooltip. */
  gloss: string;
  icon: LucideIcon;
};

export const distributionModeMeta: Record<
  DistributionMode,
  DistributionModeMeta
> = {
  [DistributionMode.AutoInstall]: {
    label: "Required",
    gloss: "Auto-installed for every targeted member",
    icon: PinIcon,
  },
  [DistributionMode.OptIn]: {
    label: "Offered",
    gloss: "Members can accept and install it",
    icon: BuildingIcon,
  },
};
