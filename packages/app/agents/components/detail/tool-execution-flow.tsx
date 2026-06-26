"use client";

import type {
  SyncedAgentSessionAgent,
  SyncedAgentSessionEvent,
} from "@repo/api/src/types/agent-session";
import { formatTime as formatLocalTime } from "@repo/app/shared/lib/date-utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { useMemo } from "react";
import {
  buildAgentTree,
  flattenTree,
  getStatusColor,
  getUnattributedEvents,
} from "./agent-tree-utils";

type ToolExecutionFlowProps = {
  agents: SyncedAgentSessionAgent[];
  events: SyncedAgentSessionEvent[];
};

type AgentLane = {
  agentId: string;
  agentName: string;
  agentStatus: string;
  depth: number;
  dots: EventDot[];
};

type EventDot = {
  id: string;
  positionPercent: number;
  toolName: string;
  timestamp: string;
  summary: string | null;
  isError: boolean;
  hue: number;
};

function hashStringToHue(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) % 360;
  }
  return hash;
}

function getEventTime(isoStr: string): number | null {
  const time = new Date(isoStr).getTime();
  return Number.isNaN(time) ? null : time;
}

function formatTime(isoStr: string): string {
  const date = new Date(isoStr);
  if (Number.isNaN(date.getTime())) {
    return isoStr;
  }
  return formatLocalTime(date, { includeSeconds: true });
}

export function ToolExecutionFlow({ agents, events }: ToolExecutionFlowProps) {
  const lanes = useMemo(() => {
    const toolEvents = events.filter((e) => e.toolName);
    if (toolEvents.length === 0) {
      return [];
    }

    const timestamps = toolEvents
      .map((event) => getEventTime(event.createdAt))
      .filter((timestamp) => timestamp !== null);
    const minTime = timestamps.length > 0 ? Math.min(...timestamps) : 0;
    const maxTime = timestamps.length > 0 ? Math.max(...timestamps) : 0;
    const range = maxTime - minTime;

    const roots = buildAgentTree(agents, events);
    const flatNodes = flattenTree(roots);

    const result: AgentLane[] = [];
    for (const node of flatNodes) {
      const agentToolEvents = toolEvents.filter(
        (e) => e.agentExternalId === node.agent.externalAgentId
      );
      if (agentToolEvents.length === 0) {
        continue;
      }

      const dots: EventDot[] = agentToolEvents.map((e) => {
        const time = getEventTime(e.createdAt);
        const positionPercent =
          range > 0 && time !== null ? ((time - minTime) / range) * 100 : 50;
        return {
          id: e.externalEventId,
          positionPercent,
          toolName: e.toolName!,
          timestamp: e.createdAt,
          summary: e.summary ?? null,
          isError: e.eventType.toLowerCase().includes("error"),
          hue: hashStringToHue(e.toolName!),
        };
      });

      result.push({
        agentId: node.agent.externalAgentId,
        agentName: node.agent.name,
        agentStatus: node.agent.status,
        depth: node.depth,
        dots,
      });
    }

    const orphanToolEvents = getUnattributedEvents(agents, toolEvents);
    if (orphanToolEvents.length > 0) {
      result.push({
        agentId: "unattributed-telemetry",
        agentName: "Unattributed telemetry",
        agentStatus: "unknown",
        depth: 0,
        dots: orphanToolEvents.map((event) => {
          const toolName = event.toolName ?? "unknown tool";
          const time = getEventTime(event.createdAt);
          const positionPercent =
            range > 0 && time !== null ? ((time - minTime) / range) * 100 : 50;
          return {
            id: event.externalEventId,
            positionPercent,
            toolName,
            timestamp: event.createdAt,
            summary: event.summary ?? null,
            isError: event.eventType.toLowerCase().includes("error"),
            hue: hashStringToHue(toolName),
          };
        }),
      });
    }

    return result;
  }, [agents, events]);

  if (lanes.length === 0) {
    return (
      <div className="py-8 text-center text-muted-foreground text-sm">
        No tool invocations captured for this session.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto pt-4">
      <div className="min-w-[360px] space-y-1">
        <div className="mb-3 flex items-center justify-between text-muted-foreground text-xs">
          <span>Earlier</span>
          <span>Later</span>
        </div>

        {lanes.map((lane) => (
          <div className="flex items-center gap-3" key={lane.agentId}>
            <div
              className="flex w-40 shrink-0 items-center gap-1.5 truncate"
              style={{ paddingLeft: lane.depth * 12 }}
            >
              <span
                className={`inline-block h-2 w-2 shrink-0 rounded-full ${getStatusColor(lane.agentStatus)}`}
              />
              <span
                className="truncate font-medium text-xs"
                title={lane.agentName}
              >
                {lane.agentName}
              </span>
            </div>

            <div className="relative h-6 flex-1 rounded-sm bg-muted/50">
              <TooltipProvider>
                {lane.dots.map((dot) => (
                  <Tooltip key={dot.id}>
                    <TooltipTrigger asChild>
                      <div
                        className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 cursor-default rounded-full border border-background"
                        style={{
                          left: `${dot.positionPercent}%`,
                          backgroundColor: dot.isError
                            ? "rgb(239, 68, 68)"
                            : `hsl(${dot.hue}, 65%, 50%)`,
                        }}
                      />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs" side="top">
                      <div className="space-y-0.5 text-xs">
                        <div className="font-medium">{dot.toolName}</div>
                        <div className="text-muted-foreground">
                          {formatTime(dot.timestamp)}
                        </div>
                        {dot.summary && (
                          <div className="line-clamp-2">{dot.summary}</div>
                        )}
                        {dot.isError && (
                          <div className="font-medium text-red-500">Error</div>
                        )}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                ))}
              </TooltipProvider>
            </div>

            <span className="w-8 shrink-0 text-right text-muted-foreground text-xs">
              {lane.dots.length}
            </span>
          </div>
        ))}

        <div className="mt-4 border-t pt-3">
          <p className="text-muted-foreground text-xs">
            Each dot represents a tool invocation. Color encodes the tool name;
            red indicates an error event. Hover for details.
          </p>
        </div>
      </div>
    </div>
  );
}
