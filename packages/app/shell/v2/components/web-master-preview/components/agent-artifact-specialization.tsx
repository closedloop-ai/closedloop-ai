"use client";

import { columnWidthBounds } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-model";
import {
  type ArtifactListColumnExtension,
  type ArtifactListSummaryMetric,
  GenericArtifactListShell,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-shells";
import {
  type ArtifactDetailsPresentation,
  CollaboratorsEditor,
  MultiValueEditor,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/generic-artifact-detail-shell";
import {
  ArtifactKind,
  type ArtifactSessionTrace,
  ArtifactStatus,
  type GenericArtifact,
  genericArtifactSessionTrace,
} from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import {
  CHIP_FOCUS_RING_CLASS,
  Chip,
} from "@repo/design-system/components/ui/chip";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import {
  ColumnAlignment,
  ColumnFieldKind,
} from "@repo/design-system/lib/column-registry";
import { cn } from "@repo/design-system/lib/utils";
import {
  BotIcon,
  BracesIcon,
  PlugIcon,
  ScrollTextIcon,
  SparklesIcon,
  TerminalSquareIcon,
  WebhookIcon,
  WorkflowIcon,
  WrenchIcon,
} from "lucide-react";
import { useState } from "react";
import { sessionRows } from "../../../../../agents/components/sessions/web-master-legacy-preview/mock"; // Cross-slice: preview shell hosts the Sessions preview (ISS-12938).
import { ArtifactTypeIcons } from "../shared/artifact-icons";
import {
  type AgentComponentRecord,
  AgentComponentType,
  NAME_PARTS_PATTERN,
  OBSERVED_COMPONENT_TYPES,
  recordFor,
} from "./agent-artifact-model";

const INVOCATION_DURATION_PATTERN = /(?:(\d+)h)?\s*(?:(\d+)m)?/;
const USAGE_BAR_HEIGHTS = [
  { id: "day-01", height: 36 },
  { id: "day-03", height: 58 },
  { id: "day-05", height: 44 },
  { id: "day-08", height: 82 },
  { id: "day-10", height: 68 },
  { id: "day-12", height: 96 },
  { id: "day-15", height: 72 },
  { id: "day-17", height: 54 },
  { id: "day-20", height: 88 },
  { id: "day-23", height: 64 },
  { id: "day-26", height: 78 },
  { id: "day-30", height: 48 },
] as const;

function componentTypeIcon(componentType: AgentComponentType) {
  switch (componentType) {
    case AgentComponentType.Agent:
      return BotIcon;
    case AgentComponentType.Command:
      return TerminalSquareIcon;
    case AgentComponentType.Skill:
      return SparklesIcon;
    case AgentComponentType.Workflow:
    case AgentComponentType.Orchestration:
      return WorkflowIcon;
    case AgentComponentType.Mcp:
    case AgentComponentType.Plugin:
      return PlugIcon;
    case AgentComponentType.Hook:
      return WebhookIcon;
    case AgentComponentType.Config:
      return BracesIcon;
    case AgentComponentType.Tool:
      return WrenchIcon;
    default:
      return ScrollTextIcon;
  }
}

export const agentSummaryMetricDefinitions = [
  metricDefinition(
    "components",
    "Agentic Components",
    "Agentic components",
    "Count of matching agentic components.",
    12
  ),
  metricDefinition(
    "invocations",
    "Invocations",
    "Runtime usage",
    "Total invocations of matching components.",
    18
  ),
  metricDefinition(
    "loc-dollar",
    "LOC / $",
    "Attributed efficiency",
    "Median reliable lines changed per AI dollar.",
    6,
    MetricPolarity.HigherIsBetter
  ),
  metricDefinition(
    "authors",
    "Authors",
    "Component authors",
    "Distinct people who authored matching components.",
    9
  ),
] as const;

// Polarity defaults to Neutral: a rise in an inventory count is neither a win
// nor a loss, and the metric card must not claim a verdict the metric does not
// carry. Metrics with a real direction pass it explicitly.
function metricDefinition(
  key: string,
  label: string,
  what: string,
  how: string,
  delta: number,
  deltaPolarity: MetricPolarity = MetricPolarity.Neutral
) {
  return { delta, deltaPolarity, key, label, info: { what, how } };
}

export function buildAgentSummaryMetrics(
  artifacts: readonly GenericArtifact[]
): ArtifactListSummaryMetric[] {
  const visible = artifacts.map(recordFor);
  const reliable = visible
    .map((record) => record.locPerDollar)
    .filter((value): value is number => value !== null);
  const authors = new Set(
    artifacts.flatMap((artifact) => artifact.collaborators)
  );
  const values = [
    String(artifacts.length),
    visible
      .reduce((total, record) => total + record.invocations, 0)
      .toLocaleString(),
    reliable.length
      ? (
          reliable.reduce((total, value) => total + value, 0) / reliable.length
        ).toFixed(1)
      : "—",
    String(authors.size),
  ];
  return agentSummaryMetricDefinitions.map((definition, index) => ({
    ...definition,
    value: values[index] ?? "0",
  }));
}

export const agentColumns: readonly ArtifactListColumnExtension[] = [
  column(
    "component-type",
    "Component type",
    132,
    (record) => record.componentType,
    ColumnFieldKind.Choice,
    true
  ),
  column(
    "source",
    "Source",
    210,
    (record) => record.source,
    ColumnFieldKind.Reference
  ),
  column(
    "harness",
    "Harness",
    112,
    (record) => record.harness,
    ColumnFieldKind.Choice,
    true
  ),
  // The four counts below are host-rendered and grouped by their rendered
  // string, which `Number` refuses; `Custom` is the registry's escape hatch.
  column(
    "invocations",
    "Invocations",
    112,
    (record) => record.invocations,
    ColumnFieldKind.Custom
  ),
  column(
    "usage-sessions",
    "Usage sessions",
    126,
    (record) => record.usageSessions,
    ColumnFieldKind.Custom
  ),
  column(
    "loc-dollar",
    "LOC / $",
    104,
    (record) => record.locPerDollar ?? "—",
    ColumnFieldKind.Custom
  ),
  column(
    "versions",
    "Versions",
    96,
    (record) =>
      OBSERVED_COMPONENT_TYPES.has(record.componentType)
        ? "—"
        : record.versionCount,
    ColumnFieldKind.Custom
  ),
];

function column(
  id: string,
  label: string,
  width: number,
  value: (record: AgentComponentRecord) => string | number,
  kind: ColumnFieldKind,
  chip = false
): ArtifactListColumnExtension {
  return {
    filterable: true,
    filterValues: (artifact) => [String(value(recordFor(artifact)))],
    groupable: true,
    groupValue: (artifact) => String(value(recordFor(artifact))),
    id,
    kind,
    label,
    renderCell: (artifact) => {
      const rendered = value(recordFor(artifact));
      return chip ? (
        <Chip
          className="min-w-0 shrink"
          title={String(rendered)}
          variant="muted"
        >
          <span className="min-w-0 truncate">{rendered}</span>
        </Chip>
      ) : (
        <span className="truncate text-sm">
          {typeof rendered === "number" ? rendered.toLocaleString() : rendered}
        </span>
      );
    },
    sortable: true,
    sortValue: (artifact) => value(recordFor(artifact)),
    width: columnWidthBounds(width),
  };
}

export function AgentArtifactCanvas({
  artifact,
}: {
  artifact: GenericArtifact;
}) {
  const record = recordFor(artifact);
  const isObserved = OBSERVED_COMPONENT_TYPES.has(record.componentType);
  const ComponentIcon = componentTypeIcon(record.componentType);
  const invocationSessions = invocationSessionsFor(record);
  const metrics = [
    [
      "LOC / $",
      record.locPerDollar?.toFixed(2) ?? "—",
      "Reliable lines changed per attributed AI dollar",
    ],
    ["Invocations", record.invocations.toLocaleString(), "Recorded uses"],
    [
      "Sessions",
      record.usageSessions.toLocaleString(),
      "Sessions that invoked this component",
    ],
    [
      "Merged PRs",
      record.mergedPrs?.toLocaleString() ?? "—",
      "Merged pull requests associated with usage sessions",
    ],
  ] as const;
  return (
    <div className="size-full overflow-auto px-6 py-6">
      <section className="border-b pb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-muted-foreground text-xs uppercase tracking-[0.12em]">
              <ComponentIcon className="size-4" />
              {record.componentType} · {record.harness}
            </div>
            <h1 className="mt-2 truncate font-semibold text-2xl tracking-tight">
              {artifact.title}
            </h1>
            <p className="mt-2 max-w-3xl text-muted-foreground text-sm">
              {artifact.summary}
            </p>
          </div>
          <Chip
            variant={
              artifact.status === ArtifactStatus.Active ? "success" : "warning"
            }
          >
            {artifact.status}
          </Chip>
        </div>
      </section>

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {metrics.map(([label, value, info]) => (
          <MetricCard
            info={{
              what: info,
              how: "Calculated from usage evidence for the selected definition version.",
            }}
            key={label}
            label={label}
            value={value}
          />
        ))}
      </div>

      <section className="mt-8">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-semibold text-base">
              {isObserved ? "Observed interface" : "Definition"}
            </h2>
            <p className="mt-1 text-muted-foreground text-sm">
              {isObserved
                ? "Supplied by the runtime or provider"
                : `Current definition · ${artifact.currentVersion}`}
            </p>
          </div>
          <Chip variant="muted">
            {isObserved ? "Observed" : `${record.versionCount} versions`}
          </Chip>
        </div>
        <pre className="mt-3 whitespace-pre-wrap rounded-md border bg-muted/30 p-4 font-mono text-sm leading-6">
          {record.definition}
        </pre>
      </section>

      <section className="mt-8">
        <div>
          <div>
            <h2 className="font-semibold text-base">Usage over time</h2>
            <p className="mt-1 text-muted-foreground text-sm">
              Runtime use of this component is review evidence, not component
              authorship.
            </p>
          </div>
        </div>
        <div className="mt-4 grid h-40 grid-cols-[2.5rem_minmax(0,1fr)] gap-2">
          <div className="flex flex-col justify-between pb-1 text-right text-muted-foreground text-xs">
            <span>{record.invocations.toLocaleString()}</span>
            <span>{Math.round(record.invocations / 2).toLocaleString()}</span>
            <span>0</span>
          </div>
          <div className="relative flex items-end gap-2 border-b px-2">
            <div className="pointer-events-none absolute inset-x-0 top-1/2 border-border/60 border-t" />
            {USAGE_BAR_HEIGHTS.map(({ height, id }) => {
              const value = Math.max(
                1,
                Math.round((record.invocations * height) / 100)
              );
              return (
                <Tooltip key={id}>
                  <TooltipTrigger asChild>
                    <button
                      aria-label={`${value.toLocaleString()} invocations`}
                      className={cn(
                        "relative flex h-full flex-1 items-end",
                        CHIP_FOCUS_RING_CLASS
                      )}
                      type="button"
                    >
                      <span
                        className="w-full rounded-t-sm bg-primary/70 transition-colors hover:bg-primary"
                        style={{ height: `${height}%` }}
                      />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {value.toLocaleString()} invocations
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </div>
        <div className="mt-2 ml-[3.25rem] flex justify-between text-muted-foreground text-xs">
          <span>30 days ago</span>
          <span>Today</span>
        </div>
      </section>

      <section className="mt-8 pb-8">
        <div>
          <h2 className="font-semibold text-base">Invocations</h2>
          <p className="mt-1 text-muted-foreground text-sm">
            Sessions that invoked this component.
          </p>
        </div>
        <AgentInvocationSessionsTable sessions={invocationSessions} />
      </section>
    </div>
  );
}

type InvocationSession = {
  id: string;
  href: string;
  name: string;
  status: "Completed" | "Active";
  owner: string;
  model: string;
  duration: string;
  cost: string;
  lastActive: string;
};

const INVOCATION_SESSION_NAMES = [
  "prototype-ready-for-review",
  "VQA production website against prototypes exhaustively",
  "Full logical VQA of platform pages",
  "Confirm feature works as expected",
  "Review generic artifact list layout",
  "Audit artifact detail interactions",
  "Compare session timeline behavior",
  "Validate responsive comment rail",
  "Review branch specialization",
  "Check document editor consistency",
  "Evaluate agent definition UX",
  "Audit custom field interactions",
  "Review table keyboard navigation",
  "Validate column resize behavior",
  "Compare inline editing patterns",
  "Review prototype artifact canvas",
  "Audit linked artifact tables",
  "Validate activity history layout",
  "Review session trace comments",
  "Check compact table fallback",
  "Confirm final design consistency",
] as const;

function invocationSessionsFor(
  record: AgentComponentRecord
): InvocationSession[] {
  const names = [
    ...record.usageExamples,
    ...INVOCATION_SESSION_NAMES.filter(
      (name) => !record.usageExamples.includes(name)
    ),
  ].slice(0, record.usageSessions);
  const owners = record.artifact.collaborators.length
    ? record.artifact.collaborators
    : [record.artifact.owner];
  return names.map((name, index) => {
    const sessionArtifact = sessionRows[index % sessionRows.length];
    const sessionId = sessionArtifact?.id ?? sessionRows[0]?.id ?? "ses_9f31";
    const params = new URLSearchParams({
      agent: record.artifact.id,
      traceRow: String(1 + (index % 3)),
      sessionTitle: name,
      tab: "sessions",
    });
    return {
      id: `${record.artifact.id}-invocation-${index + 1}`,
      href: `/p/web-master/sessions/${encodeURIComponent(sessionId)}?${params.toString()}`,
      name,
      status: index === 0 ? "Active" : "Completed",
      owner: owners[index % owners.length] ?? record.artifact.owner,
      model: record.model,
      duration: `${Math.floor(index / 4) + 1}h ${8 + ((index * 7) % 52)}m`,
      cost: `$${(6.2 + index * 3.71).toFixed(2)}`,
      lastActive: index === 0 ? "just now" : `${index}d ago`,
    };
  });
}

function AgentInvocationSessionsTable({
  sessions,
}: {
  sessions: InvocationSession[];
}) {
  const sessionByArtifactId = new Map<string, InvocationSession>();
  const artifacts = sessions.map((session, index): GenericArtifact => {
    const artifact: GenericArtifact = {
      activityCount: 1,
      aiSpend: Number(session.cost.replace(/[$,]/g, "")),
      collaborators: [],
      commentCount: 0,
      createdAgoDays: index,
      currentVersion: "1",
      id: session.id,
      kind: ArtifactKind.Session,
      outcomeScore: session.status === "Completed" ? 100 : 50,
      owner: session.owner,
      ownerInitials: initialsFor(session.owner),
      project: null,
      relationshipCount: 1,
      repository: null,
      slug: `SES-${String(index + 1).padStart(3, "0")}`,
      status:
        session.status === "Active"
          ? ArtifactStatus.Active
          : ArtifactStatus.Completed,
      summary: `Invoked this agentic component using ${session.model}.`,
      tags: [],
      timeToReadyMinutes: 0,
      title: session.name,
      updated: session.lastActive,
      updatedAgoMinutes: session.lastActive === "just now" ? 0 : index * 1440,
    };
    sessionByArtifactId.set(artifact.id, session);
    return artifact;
  });
  const columns: readonly ArtifactListColumnExtension[] = [
    invocationColumn("model", "Model", 128, sessionByArtifactId),
    invocationColumn("duration", "Duration", 112, sessionByArtifactId),
    invocationColumn("cost", "Cost", 104, sessionByArtifactId),
  ];

  return (
    <div className="mt-4 overflow-hidden border-y">
      <GenericArtifactListShell
        additionalColumns={columns}
        artifacts={artifacts}
        defaultVisibleColumnIds={[
          "owner",
          "status",
          "updated",
          "model",
          "duration",
          "cost",
        ]}
        excludedColumnIds={[
          "collaborators",
          "comments",
          "currentVersion",
          "relatedSessions",
          "tags",
        ]}
        hasDateDimension={false}
        onOpenArtifact={() => undefined}
        onOpenArtifactHref={(artifact) =>
          sessionByArtifactId.get(artifact.id)?.href
        }
        selectionNoun={{ plural: "sessions", singular: "session" }}
        showAddArtifactButton={false}
        showAddFieldButton={false}
        showSummaryCards={false}
        summaryMetricDefinitions={[]}
        variant="embedded"
      />
    </div>
  );
}

/**
 * Neither `cost` nor `duration` is grouped here, so neither needs the `Custom`
 * escape hatch that the groupable columns above do.
 */
const INVOCATION_COLUMN_KINDS = {
  cost: ColumnFieldKind.Number,
  duration: ColumnFieldKind.Text,
  model: ColumnFieldKind.Choice,
} as const;

function invocationColumn(
  id: "cost" | "duration" | "model",
  label: string,
  width: number,
  sessions: ReadonlyMap<string, InvocationSession>
): ArtifactListColumnExtension {
  return {
    // `Number`'s kind default would right-align a header the preserved baseline
    // renders start-aligned.
    ...(id === "cost" ? { align: ColumnAlignment.Start } : {}),
    filterValues: (artifact) => {
      const value = sessions.get(artifact.id)?.[id];
      return value == null ? [] : [String(value)];
    },
    filterable: id === "model",
    groupable: id === "model",
    groupValue: (artifact) => String(sessions.get(artifact.id)?.[id] ?? "—"),
    id,
    kind: INVOCATION_COLUMN_KINDS[id],
    label,
    renderCell: (artifact) => (
      <span className="truncate text-sm">
        {sessions.get(artifact.id)?.[id] ?? "—"}
      </span>
    ),
    sortable: true,
    sortValue: (artifact) => {
      const value = String(sessions.get(artifact.id)?.[id] ?? "");
      if (id === "cost") {
        return Number(value.replace(/[$,]/g, ""));
      }
      if (id === "duration") {
        const match = INVOCATION_DURATION_PATTERN.exec(value);
        return Number(match?.[1] ?? 0) * 60 + Number(match?.[2] ?? 0);
      }
      return value;
    },
    tooltip: "Optional column header tool tip...",
    width: columnWidthBounds(width),
  };
}

function initialsFor(name: string) {
  return name
    .split(NAME_PARTS_PATTERN)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function AgentAuthorsEditor({ names }: { names: readonly string[] }) {
  const [authors, setAuthors] = useState([...names]);
  return <CollaboratorsEditor names={authors} onChange={setAuthors} />;
}

function AgentAllowedToolsEditor({ tools }: { tools: readonly string[] }) {
  return <MultiValueEditor icon={WrenchIcon} options={tools} />;
}

export function agentDetails(
  artifact: GenericArtifact
): ArtifactDetailsPresentation {
  const record = recordFor(artifact);
  const isObserved = OBSERVED_COMPONENT_TYPES.has(record.componentType);
  return {
    additionalRows: [
      {
        id: "component-type",
        label: "Type",
        editableValue: record.componentType,
        value: record.componentType,
      },
      {
        id: "source",
        label: "Source",
        editableValue: record.source,
        value: record.source,
      },
      {
        id: "authors",
        label: "Authors",
        value: <AgentAuthorsEditor names={artifact.collaborators} />,
      },
      {
        id: "harness",
        label: "Harness",
        editableValue: record.harness,
        value: record.harness,
      },
      {
        id: "format",
        label: "Format",
        editableValue: record.format,
        value: record.format,
      },
      {
        id: "model",
        label: "Model",
        editableValue: record.model,
        value: record.model,
      },
      {
        id: "allowed-tools",
        label: "Allowed tools",
        value: <AgentAllowedToolsEditor tools={record.allowedTools} />,
      },
    ],
    linkedArtifacts: [
      {
        icon: ArtifactTypeIcons.Document,
        name: "Agentic component registry",
        relationship: "Defined by",
        slug: "DOC-427",
        type: "Document",
      },
      {
        icon: ArtifactTypeIcons.Issue,
        name: "Definition provenance",
        relationship: "Validated by",
        slug: "FEA-4098",
        type: "Issue",
      },
    ],
    fields: isObserved ? { currentVersion: false } : undefined,
    sections: isObserved ? { versionHistory: false } : undefined,
    versions: Array.from(
      { length: Math.min(record.versionCount, 5) },
      (_, index) => ({
        author:
          artifact.collaborators[index % artifact.collaborators.length] ??
          artifact.owner,
        id: String(record.versionCount - index),
        state: index === 0 ? "Current" : "Superseded",
        updated: index === 0 ? artifact.updated : `${index + 1}w ago`,
      })
    ),
    activity: [
      {
        actor: artifact.owner,
        body: (
          <>
            {isObserved ? (
              "was first observed in runtime evidence."
            ) : (
              <>
                created definition version{" "}
                <strong>{artifact.currentVersion}</strong>.
              </>
            )}
          </>
        ),
        date: artifact.updated,
        id: "agent-version-created",
        kind: "event",
        version: isObserved ? undefined : artifact.currentVersion,
      },
      {
        actor: artifact.collaborators[1] ?? artifact.owner,
        body: (
          <>
            commented on the component’s{" "}
            {isObserved ? "runtime behavior" : "tool permissions"}.
          </>
        ),
        date: "2d ago",
        id: "agent-definition-comment",
        kind: "comment",
        version: isObserved ? undefined : artifact.currentVersion,
      },
    ],
  };
}

export function agentContributionTrace(
  artifact: GenericArtifact
): ArtifactSessionTrace {
  const base = genericArtifactSessionTrace.sessions;
  return {
    ...genericArtifactSessionTrace,
    sessions: base.slice(0, 3).map((session, index) => ({
      ...session,
      id: `${artifact.id}-contribution-${index + 1}`,
      title:
        [
          `Create ${artifact.currentVersion} of ${artifact.title}`,
          "Address definition review comments",
          "Verify and publish the definition",
        ][index] ?? session.title,
      prompt:
        [
          "Create a new version of this agentic component definition.",
          "Apply comments anchored to the agent definition without changing runtime evidence.",
          "Validate the definition and record the current version.",
        ][index] ?? session.prompt,
    })),
  };
}
