"use client";

import type {
  SyncedAgentSessionAgent,
  SyncedAgentSessionEvent,
} from "@repo/api/src/types/agent-session";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { useMemo } from "react";
import {
  type AgentTreeNode,
  buildAgentTree,
  getStatusBorderColor,
  getStatusColor,
} from "./agent-tree-utils";

type AgentOrchestrationGraphProps = {
  agents: SyncedAgentSessionAgent[];
  events: SyncedAgentSessionEvent[];
};

function TreeNodeCard({ node }: { node: AgentTreeNode }) {
  const borderColor = getStatusBorderColor(node.agent.status);
  const dotColor = getStatusColor(node.agent.status);

  return (
    <div className="relative">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={`flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-l-4 bg-card px-3 py-2 ${borderColor}`}
            >
              <span
                className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${dotColor}`}
              />
              <span className="min-w-0 break-words font-medium text-sm [overflow-wrap:anywhere]">
                {node.agent.name}
              </span>
              <Badge className="text-xs" variant="secondary">
                {node.agent.type}
              </Badge>
              {node.agent.subagentType && (
                <Badge className="text-xs" variant="outline">
                  {node.agent.subagentType}
                </Badge>
              )}
              {node.children.length > 0 && (
                <span className="ml-auto shrink-0 text-muted-foreground text-xs">
                  {node.children.length} sub
                </span>
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs" side="right">
            <div className="space-y-1 text-xs">
              <div>
                <span className="text-muted-foreground">Status:</span>{" "}
                {node.agent.status}
              </div>
              {node.agent.task && (
                <div>
                  <span className="text-muted-foreground">Task:</span>{" "}
                  {node.agent.task}
                </div>
              )}
              {node.agent.currentTool && (
                <div>
                  <span className="text-muted-foreground">Current tool:</span>{" "}
                  {node.agent.currentTool}
                </div>
              )}
              <div>
                <span className="text-muted-foreground">Events:</span>{" "}
                {node.eventCount} ({node.toolInvocationCount} tools,{" "}
                {node.errorCount} errors)
              </div>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {node.children.length > 0 && (
        <div className="mt-1 ml-3 space-y-1 border-muted-foreground/30 border-l pl-3 sm:ml-6 sm:pl-4">
          {node.children.map((child) => (
            <div className="relative" key={child.agent.externalAgentId}>
              <div className="absolute top-4 -left-4 h-px w-4 bg-muted-foreground/30" />
              <TreeNodeCard node={child} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function AgentOrchestrationGraph({
  agents,
  events,
}: AgentOrchestrationGraphProps) {
  const roots = useMemo(() => buildAgentTree(agents, events), [agents, events]);

  if (roots.length === 0) {
    return (
      <div className="py-8 text-center text-muted-foreground text-sm">
        No agent data available for this session.
      </div>
    );
  }

  const hasHierarchy = agents.some((a) => a.parentExternalAgentId);

  return (
    <div className="space-y-3 pt-4">
      {!hasHierarchy && (
        <p className="text-muted-foreground text-xs">
          All agents are top-level (no parent/child relationships detected).
        </p>
      )}
      <div className="space-y-2">
        {roots.map((root) => (
          <TreeNodeCard key={root.agent.externalAgentId} node={root} />
        ))}
      </div>
    </div>
  );
}
