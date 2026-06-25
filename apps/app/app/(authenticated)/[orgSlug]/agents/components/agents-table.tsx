"use client";

import type { AgentSummary } from "@repo/api/src/types/agent";
import { useAgents, useUpdateAgent } from "@repo/app/agents/hooks/use-agents";
import {
  BootstrapStatus,
  useBootstrapAgents,
} from "@repo/app/agents/hooks/use-bootstrap-agents";
import { useLocalStorageState } from "@repo/app/shared/hooks/use-local-storage-state";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  type Column,
  DataTable,
} from "@repo/design-system/components/ui/data-table";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { toast } from "@repo/design-system/components/ui/sonner";
import { Switch } from "@repo/design-system/components/ui/switch";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { BotIcon, Loader2Icon, PlusIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";
import { useComputeTargets } from "@/hooks/queries/use-compute-targets";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { BootstrapProgress } from "./bootstrap-progress";
import { CreateAgentDialog } from "./create-agent-dialog";
import { RepoPickerDialog } from "./repo-picker-dialog";

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
        {agent.sourceRepo === "" ? "Org-wide" : agent.sourceRepo}
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
  const navigation = useNavigation();
  const orgSlug = useOrgSlug();
  const searchParams = useSearchParamsValue();
  const fromOnboarding = searchParams.get("from") === "onboarding";
  const { data, isLoading, error } = useAgents();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [pageSize, setPageSize] = useLocalStorageState(
    "agents:table:pageSize",
    DEFAULT_PAGE_SIZE
  );

  const { data: computeTargets } = useComputeTargets();
  const hasAvailableCompute = computeTargets?.some((t) => t.isOnline);
  const bootstrap = useBootstrapAgents();
  const isBootstrapBusy =
    bootstrap.state.status !== BootstrapStatus.Idle &&
    bootstrap.state.status !== BootstrapStatus.Completed &&
    bootstrap.state.status !== BootstrapStatus.Error;

  const handleGenerateClick = () => {
    if (!hasAvailableCompute) {
      toast.error(
        "No compute target available. Connect a desktop app or enable cloud compute in Settings."
      );
      return;
    }
    setRepoPickerOpen(true);
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
            <Button disabled={isBootstrapBusy} onClick={handleGenerateClick}>
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

      <BootstrapProgress
        fromOnboarding={fromOnboarding}
        onDismiss={bootstrap.reset}
        state={bootstrap.state}
      />

      {isEmpty && bootstrap.state.status === BootstrapStatus.Idle && (
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
      )}

      {!isEmpty && (
        <DataTable
          columns={columns}
          data={agents}
          emptyMessage="No agents match your search."
          onPageSizeChange={setPageSize}
          onRowClick={(agent) =>
            navigation.navigate(`/${orgSlug}/agents/${agent.slug}`)
          }
          pageSize={pageSize}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          rowHref={(agent) => `/${orgSlug}/agents/${agent.slug}`}
          searchKey="name"
          searchPlaceholder="Search agents..."
        />
      )}

      <RepoPickerDialog
        onOpenChange={setRepoPickerOpen}
        onSubmit={bootstrap.dispatch}
        open={repoPickerOpen}
      />
      <CreateAgentDialog
        onOpenChange={setCreateDialogOpen}
        open={createDialogOpen}
      />
    </>
  );
}
