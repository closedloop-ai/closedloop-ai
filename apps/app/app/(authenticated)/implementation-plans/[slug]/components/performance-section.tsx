"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useState } from "react";
import { usePerformanceData } from "@/hooks/queries/use-performance";

type PerformanceSectionProps = {
  artifactId: string;
};

export function PerformanceSection({ artifactId }: PerformanceSectionProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { data: perfSummary } = usePerformanceData(artifactId);

  return (
    <Collapsible onOpenChange={setIsOpen} open={isOpen}>
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg p-3 font-medium text-sm transition-colors hover:bg-accent">
        <span>Performance</span>
        {isOpen ? (
          <ChevronUpIcon className="h-4 w-4" />
        ) : (
          <ChevronDownIcon className="h-4 w-4" />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 px-3 pb-3">
        {perfSummary == null && (
          <p className="text-muted-foreground text-sm">
            No performance data available
          </p>
        )}
        {perfSummary != null && (
          <div className="space-y-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Total Iterations</span>
              <span className="font-medium">{perfSummary.totalIterations}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Total Duration</span>
              <span className="font-medium">
                {perfSummary.totalDurationS.toFixed(1)}s
              </span>
            </div>

            {perfSummary.agentBreakdown.length > 0 && (
              <div className="space-y-2">
                <p className="font-medium text-xs">Agent Breakdown</p>
                {perfSummary.agentBreakdown.map((agent) => (
                  <div
                    className="flex items-center justify-between text-xs"
                    key={`${agent.agentType}-${agent.agentName}`}
                  >
                    <span className="truncate text-muted-foreground">
                      {agent.agentName}
                    </span>
                    <span className="ml-2 shrink-0">
                      {agent.callCount}x · {agent.totalDurationS.toFixed(1)}s
                    </span>
                  </div>
                ))}
              </div>
            )}

            {perfSummary.pipelineStepBreakdown.length > 0 && (
              <div className="space-y-2">
                <p className="font-medium text-xs">Pipeline Steps</p>
                {perfSummary.pipelineStepBreakdown.map((step) => (
                  <div
                    className="flex items-center justify-between text-xs"
                    key={step.stepName}
                  >
                    <span className="truncate text-muted-foreground">
                      {step.stepName}
                    </span>
                    <span className="ml-2 shrink-0">
                      {step.callCount}x
                      {step.skipCount > 0 ? ` · ${step.skipCount} skipped` : ""}
                      {" · "}
                      {step.totalDurationS.toFixed(1)}s
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
