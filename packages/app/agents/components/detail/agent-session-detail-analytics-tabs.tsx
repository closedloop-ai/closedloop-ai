"use client";

import type {
  SyncedAgentSessionAgent,
  SyncedAgentSessionEvent,
} from "@repo/api/src/types/agent-session";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { Activity } from "lucide-react";
import { AgentOrchestrationGraph } from "./agent-orchestration-graph";
import { ErrorPropagationMap } from "./error-propagation-map";
import { SubagentEffectivenessPanel } from "./subagent-effectiveness-panel";
import { ToolExecutionFlow } from "./tool-execution-flow";

export type AgentSessionDetailAnalyticsTabsProps = {
  agents: SyncedAgentSessionAgent[];
  defaultTab?: AgentSessionAnalyticsTab;
  events: SyncedAgentSessionEvent[];
};

export function AgentSessionDetailAnalyticsTabs({
  agents,
  defaultTab,
  events,
}: AgentSessionDetailAnalyticsTabsProps) {
  if (agents.length === 0 && !hasVisibleTelemetry(events)) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-4 w-4" />
          Agent Analytics
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs
          defaultValue={defaultTab ?? AgentSessionAnalyticsTab.Orchestration}
        >
          <div className="overflow-x-auto pb-1">
            <TabsList className="w-max">
              <TabsTrigger value={AgentSessionAnalyticsTab.Effectiveness}>
                Effectiveness
              </TabsTrigger>
              <TabsTrigger value={AgentSessionAnalyticsTab.Orchestration}>
                Orchestration
              </TabsTrigger>
              <TabsTrigger value={AgentSessionAnalyticsTab.ToolFlow}>
                Tool Flow
              </TabsTrigger>
              <TabsTrigger value={AgentSessionAnalyticsTab.Errors}>
                Error Map
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value={AgentSessionAnalyticsTab.Effectiveness}>
            <SubagentEffectivenessPanel agents={agents} events={events} />
          </TabsContent>
          <TabsContent value={AgentSessionAnalyticsTab.Orchestration}>
            <AgentOrchestrationGraph agents={agents} events={events} />
          </TabsContent>
          <TabsContent value={AgentSessionAnalyticsTab.ToolFlow}>
            <ToolExecutionFlow agents={agents} events={events} />
          </TabsContent>
          <TabsContent value={AgentSessionAnalyticsTab.Errors}>
            <ErrorPropagationMap agents={agents} events={events} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

export function hasVisibleTelemetry(
  events: SyncedAgentSessionEvent[]
): boolean {
  return events.some(
    (event) => event.toolName || event.eventType.toLowerCase().includes("error")
  );
}

export const AgentSessionAnalyticsTab = {
  Effectiveness: "effectiveness",
  Orchestration: "orchestration",
  ToolFlow: "tool-flow",
  Errors: "errors",
} as const;

export type AgentSessionAnalyticsTab =
  (typeof AgentSessionAnalyticsTab)[keyof typeof AgentSessionAnalyticsTab];
