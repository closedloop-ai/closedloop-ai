import { Chip } from "@repo/design-system/components/ui/chip";
import { ToneLabel } from "@repo/design-system/components/ui/tone-label";
import {
  BRANCH_STATUS_CONFIG,
  type BranchRow,
  BranchRowStatus,
} from "../lib/branch-row";

/**
 * Shared Branch status treatment for both List tables. Lifecycle states remain
 * low-emphasis labels; Changes requested keeps the actionable filled chip.
 */
export function renderBranchStatus(status: BranchRow["status"]) {
  const config = BRANCH_STATUS_CONFIG[status];
  if (status === BranchRowStatus.Blocked) {
    return (
      <Chip variant={config.variant}>
        <span className="size-1.5 rounded-full bg-current" />
        {config.label}
      </Chip>
    );
  }
  return <ToneLabel variant={config.variant}>{config.label}</ToneLabel>;
}
