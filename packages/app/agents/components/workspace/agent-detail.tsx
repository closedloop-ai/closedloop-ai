"use client";

/**
 * Agent component detail page (T-3.7).
 *
 * Renders the full detail view for a single agent component:
 *  - Header: kind icon + name + path subtitle
 *  - Per-kind metrics card grid (MetricCard from @repo/design-system)
 *  - Collapsible Properties panel (sourceType, source, harness, owner, collaborators)
 *  - Read-only Prompt panel (only for Subagent / Command / Skill kinds)
 *  - Sessions + Branches tabs (DetailSessionsTab + DetailBranchesTab)
 *
 * Data is fetched via `useAgentComponentDetail(slug)`. In Phase 1 the stub
 * source populates sessionsTab/branchesTab with empty arrays; the HTTP source
 * passes through whatever the server returns.
 *
 * Does NOT import from apps/prototypes or prototype mock files.
 */

import type {
  AgentComponentDetail,
  AgentComponentKind,
} from "@repo/api/src/types/agent-component";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { cn } from "@repo/design-system/lib/utils";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderGitIcon,
  TerminalIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useAgentComponentDetail } from "../../hooks/use-agent-component-detail";
import {
  CollaboratorStack,
  HARNESS_META,
  isObservedKind,
  kindMeta,
} from "../../lib/component-meta";
import { componentMetrics } from "../../lib/detail-data";
import { DetailBranchesTab } from "./detail-branches-tab";
import { DetailSessionsTab } from "./detail-sessions-tab";

// ---------------------------------------------------------------------------
// Kinds that carry a text prompt (read-only Prompt panel shown only for these)
// ---------------------------------------------------------------------------

const PROMPT_KINDS: ReadonlySet<AgentComponentKind> =
  new Set<AgentComponentKind>(["subagent", "command", "skill"]);

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const PropRow = ({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <div className="grid grid-cols-[120px_1fr] items-center gap-3">
    <span className="font-medium text-muted-foreground text-sm">{label}</span>
    <div className="flex min-w-0 items-center gap-2 text-sm">
      {icon ? (
        <span className="shrink-0 text-muted-foreground">{icon}</span>
      ) : null}
      {children}
    </div>
  </div>
);

const PropValue = ({ children }: { children: React.ReactNode }) => (
  <span className="truncate">{children}</span>
);

// ---------------------------------------------------------------------------
// DetailHeader
// ---------------------------------------------------------------------------

function DetailHeader({
  kind,
  name,
  path,
  action,
}: {
  kind: AgentComponentKind;
  name: string;
  path: string;
  action?: React.ReactNode;
}) {
  const KindIcon = kindMeta(kind).icon;
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-1.5 font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.12em]">
          <KindIcon className="size-3.5" />
          {kindMeta(kind).label}
        </span>
        <h1 className="font-semibold text-2xl tracking-tight">{name}</h1>
        <span className="text-muted-foreground text-xs">{path}</span>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PropertiesPanel
// ---------------------------------------------------------------------------

function PropertiesPanel({
  kind,
  source,
  harness,
  owner,
  collaborators,
}: {
  kind: AgentComponentKind;
  source: string;
  harness: string;
  owner: string | null;
  collaborators: readonly string[];
}) {
  const [open, setOpen] = useState(true);
  const KindIcon = kindMeta(kind).icon;

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger asChild>
        <button
          className="flex items-center gap-1.5 font-semibold text-lg tracking-tight"
          type="button"
        >
          Properties
          {open ? (
            <ChevronDownIcon className="size-5" />
          ) : (
            <ChevronRightIcon className="size-5" />
          )}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2.5">
        <div className="rounded-lg bg-muted/40 px-5 py-4">
          <div className="grid grid-cols-1 gap-x-12 gap-y-3.5 md:grid-cols-2">
            <PropRow icon={<KindIcon className="size-3.5" />} label="Type">
              <PropValue>{kindMeta(kind).label}</PropValue>
            </PropRow>

            <PropRow
              icon={<FolderGitIcon className="size-3.5" />}
              label="Source"
            >
              <PropValue>{source}</PropValue>
            </PropRow>

            <PropRow
              icon={<TerminalIcon className="size-3.5" />}
              label="Harness"
            >
              <PropValue>
                {harness in HARNESS_META
                  ? HARNESS_META[harness as keyof typeof HARNESS_META].label
                  : harness}
              </PropValue>
            </PropRow>

            <PropRow label="Owner">
              {owner === null ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                // OwnerLabel expects an AgentComponent; supply a minimal shape for rendering
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  {owner}
                </span>
              )}
            </PropRow>

            <PropRow label="Collaborators">
              <CollaboratorStack users={collaborators} />
            </PropRow>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// PromptPanel — read-only, shown only for Subagent / Command / Skill kinds
// ---------------------------------------------------------------------------

function PromptPanel({ prompt }: { prompt: string }) {
  return (
    <div className="flex flex-col gap-2.5">
      <h3 className="font-semibold text-lg tracking-tight">Prompt</h3>
      <div className="rounded-lg bg-muted/40 py-4 pr-2 pl-4">
        <div className="scrollbar-overlay max-h-96 overflow-auto pr-2">
          <div className="whitespace-pre-wrap text-sm leading-relaxed">
            {prompt}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentDetail — the public export
// ---------------------------------------------------------------------------

/**
 * Render-prop that receives the resolved component detail and returns a header
 * action node (e.g. an admin-gated "Promote & Distribute" control). Kept as a
 * surface-agnostic slot so the shell (apps/app) owns the Clerk-based admin gate
 * while this shared component stays free of any auth SDK.
 */
export type AgentDetailHeaderAction = (
  component: AgentComponentDetail
) => ReactNode;

/**
 * Render-prop that receives the resolved component detail and returns the
 * analytics section rendered below the Prompt panel (e.g. the HTTP-backed
 * "Token trend by model" chart on web).
 *
 * Kept as a surface-agnostic slot because the default chart is HTTP-only:
 * it fetches `GET /agent-components/{slug}/token-trend` via `useApiClient`,
 * which the desktop `inertDesktopApiAdapter` always rejects ("Desktop has no
 * remote REST API"). The desktop shell omits this slot and instead renders its
 * own IPC-backed `OptimizationAnalyticsPanel`, so the shared component never
 * mounts an always-failing HTTP surface on desktop.
 */
export type AgentDetailAnalyticsSlot = (
  component: AgentComponentDetail
) => ReactNode;

export function AgentDetail({
  slug,
  headerAction,
  analytics,
}: {
  slug: string;
  headerAction?: AgentDetailHeaderAction;
  analytics?: AgentDetailAnalyticsSlot;
}) {
  const { data, isLoading, isError } = useAgentComponentDetail(slug);
  const [activeTab, setActiveTab] = useState("sessions");

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
        Loading…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
        Component not found.
      </div>
    );
  }

  const metrics = componentMetrics(data);
  const path = data.properties.path;

  return (
    <div className="flex-1 overflow-auto">
      {/* Title, properties, prompt, and metrics stay inset (centered column). */}
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 pt-10 pb-6">
        <DetailHeader
          action={headerAction?.(data)}
          kind={data.kind}
          name={data.name}
          path={path}
        />

        <div
          className={cn(
            "grid grid-cols-2 gap-3 sm:grid-cols-3",
            metrics.length >= 6 ? "lg:grid-cols-6" : "lg:grid-cols-5"
          )}
        >
          {metrics.map((metric) => (
            <MetricCard
              info={metric.info}
              key={metric.key}
              label={metric.label}
              value={metric.value}
            />
          ))}
        </div>

        <PropertiesPanel
          collaborators={data.collaborators}
          harness={data.harness}
          kind={data.kind}
          owner={data.owner}
          source={data.source}
        />

        {PROMPT_KINDS.has(data.kind) &&
        isObservedKind(data.kind) &&
        data.prompt !== null ? (
          <PromptPanel prompt={data.prompt} />
        ) : null}

        {analytics?.(data)}
      </div>

      {/* The Sessions/Branches table spans the full page width. */}
      <div className="pb-6">
        <Tabs className="gap-4" onValueChange={setActiveTab} value={activeTab}>
          <div className="flex flex-wrap items-center justify-between gap-4 px-4">
            <h3 className="font-semibold text-lg tracking-tight">
              Invocations
            </h3>
            <div className="flex items-center gap-2">
              <TabsList>
                <TabsTrigger value="sessions">Sessions</TabsTrigger>
                <TabsTrigger value="branches">Branches</TabsTrigger>
              </TabsList>
            </div>
          </div>
          <TabsContent value="sessions">
            <DetailSessionsTab component={data} sessions={data.sessionsTab} />
          </TabsContent>
          <TabsContent value="branches">
            <DetailBranchesTab branches={data.branchesTab} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
