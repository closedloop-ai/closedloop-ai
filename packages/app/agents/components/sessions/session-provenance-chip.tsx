import type { SessionProvenance } from "@repo/api/src/types/branch";
import type { ReactNode } from "react";
import { ProvenanceChip } from "../../../shared/components/provenance-chip";

/**
 * FEA-3575: the `Agent`/`Bot` provenance chip surfaced next to a session
 * wherever a user inspects related session activity (the Sessions list lead and
 * the branch-detail sessions view). Human (and undefined-provenance) sessions
 * render nothing — the chip is a quiet, informational marker for automated /
 * agent-driven runs, mirroring the Branches provenance chip (FEA-3285) so the
 * two surfaces label origin identically. Composes the shared {@link ProvenanceChip},
 * qualifying its accessible label with the "session" suffix.
 */
export function SessionProvenanceChip({
  provenance,
}: {
  provenance: SessionProvenance | null | undefined;
}): ReactNode {
  return <ProvenanceChip ariaLabelSuffix="session" provenance={provenance} />;
}
