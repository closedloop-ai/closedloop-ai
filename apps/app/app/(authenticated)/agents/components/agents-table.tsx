"use client";

import type { AgentSummary } from "@repo/api/src/types/agent";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  type Column,
  DataTable,
} from "@repo/design-system/components/ui/data-table";
import { toast } from "@repo/design-system/components/ui/sonner";
import { Switch } from "@repo/design-system/components/ui/switch";
import { BotIcon, Loader2Icon, PlusIcon, SparklesIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { useAgents, useUpdateAgent } from "@/hooks/queries/use-agents";
import { useLocalStorageState } from "@/hooks/use-local-storage-state";
import { formatRelativeTime } from "@/lib/date-utils";
import { CreateAgentDialog } from "./create-agent-dialog";

function EnableToggle({ agent }: Readonly<{ agent: AgentSummary }>) {
  const updateAgent = useUpdateAgent(agent.slug);

  return (
    <Switch
      checked={agent.enabled}
      onCheckedChange={(checked) => {
        updateAgent.mutate(
          { enabled: checked },
          {
            onSuccess: () => {
              toast.success(`Agent ${checked ? "enabled" : "disabled"}`);
            },
          }
        );
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

const columns: Column<AgentSummary>[] = [
  {
    key: "name",
    header: "Name",
    sortable: true,
    render: (agent) => <span className="font-medium">{agent.name}</span>,
  },
  {
    key: "role",
    header: "Role",
    sortable: true,
    render: (agent) => <Badge variant="secondary">{agent.role}</Badge>,
  },
  {
    key: "enabled",
    header: "Status",
    render: (agent) => <EnableToggle agent={agent} />,
  },
  {
    key: "sourceRepo",
    header: "Source",
    render: (agent) => (
      <span className="text-muted-foreground text-sm">
        {agent.sourceRepo ?? "Manual"}
      </span>
    ),
  },
  {
    key: "currentVersion",
    header: "Version",
    render: (agent) => (
      <span className="font-mono text-muted-foreground text-sm">
        v{agent.currentVersion}
      </span>
    ),
  },
  {
    key: "updatedAt",
    header: "Updated",
    sortable: true,
    render: (agent) => (
      <span className="text-muted-foreground text-sm">
        {formatRelativeTime(agent.updatedAt)}
      </span>
    ),
  },
];

const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_OPTIONS = [10, 25, 50];

export function AgentsTable() {
  const router = useRouter();
  const { data, isLoading, error } = useAgents();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [pageSize, setPageSize] = useLocalStorageState(
    "agents:table:pageSize",
    DEFAULT_PAGE_SIZE
  );

  const handleGenerateClick = () => {
    toast.info("Connect to Electron desktop app to generate agents.");
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/20 bg-destructive/10 p-4 text-destructive">
        {error.message ?? "Failed to load agents"}
      </div>
    );
  }

  const agents = data?.agents ?? [];
  const isEmpty = agents.length === 0;

  return (
    <>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-bold text-2xl">Agents</h1>
          <p className="text-muted-foreground">
            Manage AI agents generated for your organization
          </p>
        </div>
        {!isEmpty && (
          <div className="flex items-center gap-2">
            <Button onClick={handleGenerateClick}>
              <SparklesIcon className="h-4 w-4" />
              Generate Agents
            </Button>
            <Button onClick={() => setCreateDialogOpen(true)} variant="outline">
              <PlusIcon className="h-4 w-4" />
              Create Agent
            </Button>
          </div>
        )}
      </div>
      {isEmpty ? (
        <EmptyState
          action={
            <div className="flex items-center gap-2">
              <Button onClick={handleGenerateClick}>
                <SparklesIcon className="h-4 w-4" />
                Generate Agents
              </Button>
              <Button
                onClick={() => setCreateDialogOpen(true)}
                variant="outline"
              >
                <PlusIcon className="h-4 w-4" />
                Create Agent Manually
              </Button>
            </div>
          }
          description="Generate agents from your repositories to get started, or create one manually."
          icon={BotIcon}
          title="No agents yet"
        />
      ) : (
        <DataTable
          columns={columns}
          data={agents}
          emptyMessage="No agents match your search."
          onPageSizeChange={setPageSize}
          onRowClick={(agent) => router.push(`/agents/${agent.slug}`)}
          pageSize={pageSize}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          searchKey="name"
          searchPlaceholder="Search agents..."
        />
      )}
      <CreateAgentDialog
        onOpenChange={setCreateDialogOpen}
        open={createDialogOpen}
      />
    </>
  );
}
