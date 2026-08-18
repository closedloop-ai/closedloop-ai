import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { GitBranchIcon } from "lucide-react";

/**
 * Empty state shown when a branch has no session timeline data. Composes the
 * DS `EmptyState` (the same primitive the production tab and the
 * branch-trace-unavailable disclosure use) instead of a hand-rolled centered
 * block, so the two "nothing here" renderings reachable from this tab share
 * one design language. `titleAs="h2"` preserves the heading the hand-rolled
 * version exposed; `GitBranchIcon` matches production's no-sessions state.
 */
export function BranchSessionsEmptyState() {
  return (
    <div className="mx-auto w-full max-w-content px-5 py-4" role="status">
      <EmptyState
        description="This branch has no session activity or timeline events."
        icon={GitBranchIcon}
        title="No sessions recorded"
        titleAs="h2"
      />
    </div>
  );
}
