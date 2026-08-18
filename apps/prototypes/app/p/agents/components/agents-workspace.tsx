"use client";

import { useState } from "react";
import { KIND_ORDER } from "../component-meta";
import { type AgentComponent, AgentComponentKind } from "../mock";
import { AgentDetail } from "./agent-detail";
import { AgentsGroupedList } from "./agents-grouped-list";
import { AppShell, type Crumb } from "./app-shell";

// The design-review scope for the redesign: only agents, commands, and skills.
// Workflows, MCP tools, hooks, and Memory & config stay out of the top level,
// and Plugins move to their own top-level nav (tracked as separate work).
const SCOPED_OUT_KINDS: ReadonlySet<AgentComponentKind> = new Set([
  AgentComponentKind.Workflow,
  AgentComponentKind.Mcp,
  AgentComponentKind.Hook,
  AgentComponentKind.Config,
]);

const CORE_KINDS = KIND_ORDER.filter((kind) => !SCOPED_OUT_KINDS.has(kind));

export const AgentsWorkspace = () => {
  const [selected, setSelected] = useState<AgentComponent | null>(null);

  const clearSelection = () => setSelected(null);

  const breadcrumbs: readonly Crumb[] = selected
    ? [
        { label: "Agents", onClick: clearSelection },
        { label: selected.name, isCurrent: true },
      ]
    : [{ label: "Agents", isCurrent: true }];

  return (
    <AppShell breadcrumbs={breadcrumbs} onNavigateAgents={clearSelection}>
      {selected ? (
        <AgentDetail component={selected} />
      ) : (
        <AgentsGroupedList kinds={CORE_KINDS} onSelect={setSelected} />
      )}
    </AppShell>
  );
};
