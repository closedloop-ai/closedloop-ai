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
import { CheckCircle2Icon } from "lucide-react";
import { useMemo } from "react";
import {
  type AgentTreeNode,
  buildAgentTree,
  flattenTree,
  getUnattributedEvents,
  isErrorEvent,
} from "./agent-tree-utils";

type ErrorPropagationMapProps = {
  agents: SyncedAgentSessionAgent[];
  events: SyncedAgentSessionEvent[];
};

function hasErrorsInSubtree(node: AgentTreeNode): boolean {
  if (node.errorCount > 0 || node.isFailed) {
    return true;
  }
  return node.children.some(hasErrorsInSubtree);
}

function ErrorTreeNode({ node }: { node: AgentTreeNode }) {
  const hasErrors = node.errorCount > 0 || node.isFailed;
  const subtreeHasErrors = hasErrorsInSubtree(node);
  const isErrorChain = hasErrors && node.children.some(hasErrorsInSubtree);

  let nodeStyle = "opacity-40";
  if (hasErrors) {
    nodeStyle = "border-red-500/70 bg-red-50 dark:bg-red-950/20";
  } else if (subtreeHasErrors) {
    nodeStyle = "opacity-70";
  }

  return (
    <div className="relative">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={`flex min-w-0 flex-wrap items-center gap-2 rounded-md border px-3 py-2 transition-opacity ${nodeStyle}`}
            >
              <span className="min-w-0 break-words font-medium text-sm [overflow-wrap:anywhere]">
                {node.agent.name}
              </span>
              <Badge className="text-xs" variant="secondary">
                {node.agent.status}
              </Badge>
              {node.errorCount > 0 && (
                <Badge className="text-xs" variant="destructive">
                  {node.errorCount} error{node.errorCount > 1 ? "s" : ""}
                </Badge>
              )}
              {node.isFailed && node.errorCount === 0 && (
                <Badge className="text-xs" variant="destructive">
                  failed
                </Badge>
              )}
            </div>
          </TooltipTrigger>
          {hasErrors && (
            <TooltipContent className="max-w-xs" side="right">
              <div className="space-y-1 text-xs">
                <div className="font-medium">
                  {node.agent.name} — {node.agent.status}
                </div>
                {node.agent.task && (
                  <div className="text-muted-foreground">{node.agent.task}</div>
                )}
                <div>
                  {node.errorCount} error event
                  {node.errorCount === 1 ? "" : "s"}
                  {isErrorChain && " (child agents also have errors)"}
                </div>
              </div>
            </TooltipContent>
          )}
        </Tooltip>
      </TooltipProvider>

      {node.children.length > 0 && (
        <div
          className={`mt-1 ml-3 space-y-1 border-l pl-3 sm:ml-6 sm:pl-4 ${
            isErrorChain
              ? "border-red-400 dark:border-red-600"
              : "border-muted-foreground/30"
          }`}
        >
          {node.children.map((child) => (
            <div className="relative" key={child.agent.externalAgentId}>
              <div
                className={`absolute top-4 -left-4 h-px w-4 ${
                  isErrorChain && hasErrorsInSubtree(child)
                    ? "bg-red-400 dark:bg-red-600"
                    : "bg-muted-foreground/30"
                }`}
              />
              <ErrorTreeNode node={child} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ErrorPropagationMap({
  agents,
  events,
}: ErrorPropagationMapProps) {
  const roots = useMemo(() => buildAgentTree(agents, events), [agents, events]);

  const flatNodes = useMemo(() => flattenTree(roots), [roots]);
  const unattributedErrorEvents = useMemo(
    () => getUnattributedEvents(agents, events).filter(isErrorEvent),
    [agents, events]
  );

  const attributedErrorCount = flatNodes.reduce(
    (sum, n) => sum + n.errorCount,
    0
  );
  const totalErrors = attributedErrorCount + unattributedErrorEvents.length;
  const agentsWithErrors = flatNodes.filter(
    (n) => n.errorCount > 0 || n.isFailed
  ).length;

  if (flatNodes.length === 0 && unattributedErrorEvents.length === 0) {
    return (
      <div className="py-8 text-center text-muted-foreground text-sm">
        No agent data available for this session.
      </div>
    );
  }

  if (totalErrors === 0 && !flatNodes.some((n) => n.isFailed)) {
    return (
      <div className="flex flex-col items-center gap-2 py-8">
        <CheckCircle2Icon className="h-8 w-8 text-emerald-500" />
        <p className="font-medium text-sm">No errors in this session</p>
        <p className="text-muted-foreground text-xs">
          All {flatNodes.length} agent{flatNodes.length === 1 ? "" : "s"}{" "}
          completed without errors.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 pt-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">
          {agentsWithErrors} agent{agentsWithErrors === 1 ? "" : "s"}{" "}
          encountered errors
        </span>
        <Badge variant="destructive">
          {totalErrors} error event{totalErrors === 1 ? "" : "s"} total
        </Badge>
      </div>

      <div className="space-y-2">
        {roots.map((root) => (
          <ErrorTreeNode key={root.agent.externalAgentId} node={root} />
        ))}
        {unattributedErrorEvents.length > 0 && (
          <div className="rounded-md border border-red-500/70 bg-red-50 px-3 py-2 dark:bg-red-950/20">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-sm">
                Unattributed telemetry
              </span>
              <Badge className="text-xs" variant="destructive">
                {unattributedErrorEvents.length} error
                {unattributedErrorEvents.length === 1 ? "" : "s"}
              </Badge>
            </div>
            <div className="mt-2 space-y-1">
              {unattributedErrorEvents.map((event) => (
                <p
                  className="text-muted-foreground text-xs"
                  key={event.externalEventId}
                >
                  {event.summary || event.eventType}
                </p>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="border-t pt-3">
        <p className="text-muted-foreground text-xs">
          Red-highlighted nodes have errors or failed. Red connector lines
          indicate error propagation chains (child error caused parent failure).
          Faded nodes are unaffected.
        </p>
      </div>
    </div>
  );
}
