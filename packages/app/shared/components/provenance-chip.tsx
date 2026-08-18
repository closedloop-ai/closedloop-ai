import { BranchProvenance } from "@repo/api/src/types/branch";
import { Chip } from "@repo/design-system/components/ui/chip";
import { BotIcon } from "lucide-react";
import type { ReactNode } from "react";

/** Visible label per non-human provenance. Human provenance renders no chip. */
const PROVENANCE_LABELS = {
  [BranchProvenance.Agent]: "Agent",
  [BranchProvenance.Bot]: "Bot",
} as const;

/**
 * Shared provenance chip for the `Agent`/`Bot` origin marker, composed by both
 * the Branches table (FEA-3285) and the Sessions surfaces (FEA-3575) so the two
 * label origin identically. A quiet, muted, informational marker — not a status.
 * Human (and undefined/null) provenance renders nothing.
 *
 * `ariaLabelSuffix` qualifies the accessible label per surface (e.g. `"session"`
 * → `"Agent session"`); omit it to leave the chip's own text as the label.
 */
export function ProvenanceChip({
  provenance,
  ariaLabelSuffix,
}: {
  provenance: BranchProvenance | null | undefined;
  ariaLabelSuffix?: string;
}): ReactNode {
  if (
    provenance !== BranchProvenance.Agent &&
    provenance !== BranchProvenance.Bot
  ) {
    return null;
  }
  const label = PROVENANCE_LABELS[provenance];
  return (
    <Chip
      aria-label={ariaLabelSuffix ? `${label} ${ariaLabelSuffix}` : undefined}
      className="gap-1"
      variant="muted"
    >
      <BotIcon aria-hidden className="size-3" />
      {label}
    </Chip>
  );
}

/**
 * The visible label {@link ProvenanceChip} would render, or `null` when it
 * renders nothing (human / absent provenance).
 *
 * ISS-5282: a caller that lists this chip alongside others — the Sessions row
 * qualifier list, whose overflow counter NAMES what it is hiding — needs the
 * word without rendering the chip. Reading it from {@link PROVENANCE_LABELS}
 * rather than re-spelling "Agent"/"Bot" at the call site keeps the counter and
 * the chip incapable of disagreeing.
 */
export function provenanceChipLabel(
  provenance: BranchProvenance | null | undefined
): string | null {
  if (
    provenance !== BranchProvenance.Agent &&
    provenance !== BranchProvenance.Bot
  ) {
    return null;
  }
  return PROVENANCE_LABELS[provenance];
}
