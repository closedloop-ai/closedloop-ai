"use client";

import type {
  SyncedAgentSessionAgent,
  SyncedAgentSessionEvent,
} from "@repo/api/src/types/agent-session";
import { formatDurationMs } from "@repo/app/shared/lib/format-duration-ms";
import { formatNumber } from "@repo/app/shared/lib/format-utils";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
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
  flattenTree,
  getStatusColor,
} from "./agent-tree-utils";

type SubagentEffectivenessPanelProps = {
  agents: SyncedAgentSessionAgent[];
  events: SyncedAgentSessionEvent[];
};

function AgentRow({ node }: { node: AgentTreeNode }) {
  const indent = node.depth * 16;

  return (
    <TableRow>
      <TableCell>
        <div
          className="flex items-center gap-2"
          style={{ paddingLeft: indent }}
        >
          {node.depth > 0 && (
            <span className="text-muted-foreground text-xs">{"└"}</span>
          )}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-default font-medium">
                  {node.agent.name}
                </span>
              </TooltipTrigger>
              {node.agent.task && (
                <TooltipContent>
                  <p className="max-w-xs text-xs">{node.agent.task}</p>
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
        </div>
      </TableCell>
      <TableCell>
        <Badge className="text-xs" variant="secondary">
          {node.agent.type}
          {node.agent.subagentType ? ` / ${node.agent.subagentType}` : ""}
        </Badge>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1.5">
          <span
            className={`inline-block h-2 w-2 rounded-full ${getStatusColor(node.agent.status)}`}
          />
          <span className="text-sm">{node.agent.status}</span>
        </div>
      </TableCell>
      <TableCell className="text-right font-mono text-sm">
        {formatDurationMs(node.durationMs)}
      </TableCell>
      <TableCell className="text-right">
        {formatNumber(node.toolInvocationCount)}
      </TableCell>
      <TableCell className="text-right">
        {node.errorCount > 0 ? (
          <span className="font-medium text-red-600">
            {formatNumber(node.errorCount)}
          </span>
        ) : (
          <span className="text-muted-foreground">0</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        {formatNumber(node.eventCount)}
      </TableCell>
    </TableRow>
  );
}

export function SubagentEffectivenessPanel({
  agents,
  events,
}: SubagentEffectivenessPanelProps) {
  const flatNodes = useMemo(() => {
    const roots = buildAgentTree(agents, events);
    return flattenTree(roots);
  }, [agents, events]);

  if (flatNodes.length === 0) {
    return (
      <div className="py-8 text-center text-muted-foreground text-sm">
        No agent data available for this session.
      </div>
    );
  }

  const successCount = flatNodes.filter((n) => n.isSuccess).length;
  const failedCount = flatNodes.filter((n) => n.isFailed).length;

  return (
    <div className="space-y-4 pt-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
          <span>{successCount} completed</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-red-500" />
          <span>{failedCount} failed</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-gray-400" />
          <span>{flatNodes.length - successCount - failedCount} other</span>
        </div>
      </div>

      <Table className="min-w-[720px]">
        <TableHeader>
          <TableRow>
            <TableHead>Agent</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Duration</TableHead>
            <TableHead className="text-right">Tool Uses</TableHead>
            <TableHead className="text-right">Errors</TableHead>
            <TableHead className="text-right">Events</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {flatNodes.map((node) => (
            <AgentRow key={node.agent.externalAgentId} node={node} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
