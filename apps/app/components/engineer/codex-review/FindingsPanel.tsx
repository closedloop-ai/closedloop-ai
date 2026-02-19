import { cn } from "@repo/design-system/lib/utils";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { ReviewFindings } from "@/lib/engineer/codex-review-parser";
import { groupFindingsByPriority } from "./constants";
import { FindingCard } from "./FindingCard";
import { PriorityBadge } from "./PriorityBadge";

type FindingsPanelProps = {
  findings: ReviewFindings;
  dismissedFindings: Set<number>;
  expandedFindings: Set<number>;
  chatMode: boolean;
  selectedFindingIndex: number | null;
  onToggleExpand: (idx: number) => void;
  onToggleDismiss: (idx: number) => void;
  onOpenChat: (idx: number) => void;
  onSelectFinding: (idx: number) => void;
};

export function FindingsPanel({
  findings,
  dismissedFindings,
  expandedFindings,
  chatMode,
  selectedFindingIndex,
  onToggleExpand,
  onToggleDismiss,
  onOpenChat,
  onSelectFinding,
}: Readonly<FindingsPanelProps>) {
  const activeCount = findings.findings.length - dismissedFindings.size;
  const groups = groupFindingsByPriority(findings.findings);
  const allResolved = findings.approved || activeCount === 0;

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div
        className={cn(
          "rounded-lg border p-4",
          allResolved
            ? "border-emerald-500/30 bg-emerald-500/10"
            : "border-amber-500/30 bg-amber-500/10"
        )}
      >
        <div className="mb-2 flex items-center gap-2">
          {allResolved ? (
            <CheckCircle2 className="size-5 text-emerald-500" />
          ) : (
            <AlertTriangle className="size-5 text-amber-500" />
          )}
          <span className="font-medium">
            {allResolved ? "All Findings Resolved" : "Items Need Attention"}
          </span>
        </div>
        <p className="text-muted-foreground text-sm">{findings.summary}</p>
      </div>

      {/* Grouped findings */}
      {findings.findings.length > 0 && (
        <div className="space-y-4">
          <h4 className="font-medium text-muted-foreground text-sm">
            Findings ({activeCount} of {findings.findings.length})
          </h4>
          {groups.map((group) => (
            <div className="space-y-2" key={group.priority}>
              <div className="flex items-center gap-2">
                <PriorityBadge priority={group.priority} />
                <span className="font-medium text-muted-foreground text-xs">
                  {group.label} ({group.findings.length})
                </span>
              </div>
              <div className="space-y-2">
                {group.findings.map(({ finding, originalIndex }) => (
                  <FindingCard
                    chatMode={chatMode}
                    finding={finding}
                    idx={originalIndex}
                    isDismissed={dismissedFindings.has(originalIndex)}
                    isExpanded={expandedFindings.has(originalIndex)}
                    isSelected={
                      chatMode && selectedFindingIndex === originalIndex
                    }
                    key={originalIndex}
                    onOpenChat={onOpenChat}
                    onSelectFinding={onSelectFinding}
                    onToggleDismiss={onToggleDismiss}
                    onToggleExpand={onToggleExpand}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
