"use client";

import { Chip } from "@repo/design-system/components/ui/chip";
import {
  GridEmptyValue,
  GridTable,
  type GridTableColumn,
  type GridTableGroup,
  ROW_ACTIONS_COLUMN,
} from "@repo/design-system/components/ui/grid-table";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import {
  ActivityIcon,
  BotIcon,
  EllipsisIcon,
  FolderGit2Icon,
  FolderGitIcon,
  GaugeIcon,
  LaptopIcon,
  LayersIcon,
  PackageIcon,
  ShapesIcon,
  UsersIcon,
} from "lucide-react";
import { useState } from "react";
import {
  CollaboratorStack,
  HARNESS_META,
  HARNESS_ORDER,
  HarnessBadge,
  KIND_META,
  KindBadge,
  LOC_PER_DOLLAR_COLUMN_LABEL,
  LOC_PER_DOLLAR_FORMAT,
  NUMBER_FORMAT,
} from "../component-meta";
import {
  type AgentComponent,
  type AgentComponentKind,
  collaboratorsFor,
  mockComponents,
  SourceType,
} from "../mock";
import { AgentsFilterMenu, type FilterOption } from "./agents-filter-menu";
import {
  AgentsViewMenu,
  type GroupByOption as GroupByChoice,
  type ViewMenuColumn,
} from "./agents-view-menu";

// -----------------------------------------------------------------------------
// Columns + grouping
// -----------------------------------------------------------------------------

// The value column is a fixed session-level merged-LOC-per-dollar read,
// rendered plain (no tone) — the summary card already says to read it as a
// trend, not a score, so the column states the baseline in its header instead
// of scoring rows against it. Other metric framings can be added later as
// additional columns rather than a swappable header.
const METRIC_COLUMN = "loc-per-dollar";
const ALL_TYPES = "all";

type ColumnDef = {
  id: string;
  label: string;
  width: string;
  icon: React.ReactNode;
};

const COLUMN_DEFS: readonly ColumnDef[] = [
  {
    id: "type",
    label: "Type",
    width: "132px",
    icon: <ShapesIcon className="size-4" />,
  },
  {
    id: METRIC_COLUMN,
    label: LOC_PER_DOLLAR_COLUMN_LABEL,
    width: "168px",
    icon: <GaugeIcon className="size-4" />,
  },
  {
    id: "collaborators",
    label: "Collaborators",
    width: "148px",
    icon: <UsersIcon className="size-4" />,
  },
  {
    id: "source",
    label: "Source",
    width: "196px",
    icon: <FolderGitIcon className="size-4" />,
  },
  {
    id: "harness",
    label: "Harness",
    width: "150px",
    icon: <BotIcon className="size-4" />,
  },
  {
    id: "invocations",
    label: "Invocations",
    width: "120px",
    icon: <ActivityIcon className="size-4" />,
  },
  {
    id: "sessions",
    label: "Sessions",
    width: "108px",
    icon: <LayersIcon className="size-4" />,
  },
];

const GroupBy = {
  None: "none",
  Type: "type",
  Harness: "harness",
} as const;

type GroupBy = (typeof GroupBy)[keyof typeof GroupBy];

const GROUP_BY_OPTIONS: readonly GroupByChoice[] = [
  { value: GroupBy.None, label: "None" },
  { value: GroupBy.Type, label: "Type" },
  { value: GroupBy.Harness, label: "Harness" },
];

const sortableValue = (
  component: AgentComponent,
  columnId: string
): number | string => {
  switch (columnId) {
    case "name":
      return component.name.toLowerCase();
    case "type":
      return KIND_META[component.kind].label;
    case METRIC_COLUMN:
      return component.locPerDollar ?? -1;
    case "collaborators":
      return collaboratorsFor(component).length;
    case "source":
      return component.source.toLowerCase();
    case "harness":
      return component.harness;
    case "invocations":
      return component.invocations ?? -1;
    case "sessions":
      return component.sessions ?? -1;
    default:
      return 0;
  }
};

const compareBy = (
  a: AgentComponent,
  b: AgentComponent,
  columnId: string,
  dir: "asc" | "desc"
): number => {
  const factor = dir === "asc" ? 1 : -1;
  const av = sortableValue(a, columnId);
  const bv = sortableValue(b, columnId);
  if (typeof av === "string" && typeof bv === "string") {
    return factor * av.localeCompare(bv);
  }
  return factor * (Number(av) - Number(bv));
};

type GroupDef = {
  key: string;
  label: string;
  match: (component: AgentComponent) => boolean;
};

const groupDefsFor = (
  groupBy: GroupBy,
  kinds: readonly AgentComponentKind[]
): readonly GroupDef[] => {
  if (groupBy === GroupBy.Harness) {
    return HARNESS_ORDER.map((harness) => ({
      key: `harness-${harness}`,
      label: HARNESS_META[harness].label,
      match: (component: AgentComponent) => component.harness === harness,
    }));
  }
  return kinds.map((kind) => ({
    key: `type-${kind}`,
    label: KIND_META[kind].plural,
    match: (component: AgentComponent) => component.kind === kind,
  }));
};

// -----------------------------------------------------------------------------
// Cells
// -----------------------------------------------------------------------------

// Shared plain, tabular-figures number cell — every numeric column (LOC/$,
// Invocations, Sessions) renders through this so none of them picks up a
// heavier weight or a different empty-state than its neighbours.
const FormattedNumberCell = ({
  value,
  format,
}: {
  value: number | null;
  format: Intl.NumberFormat;
}) =>
  value === null ? (
    <GridEmptyValue />
  ) : (
    <span className="text-sm tabular-nums">{format.format(value)}</span>
  );

// LOC/$ renders plain, not toned: the summary card above says to read it as a
// trend, not a score, and a per-row tone would contradict that (design
// review). The baseline comparison lives in the column header instead.
const LocPerDollarCell = ({ value }: { value: number | null }) => (
  <FormattedNumberCell format={LOC_PER_DOLLAR_FORMAT} value={value} />
);

const NumberCell = ({ value }: { value: number | null }) => (
  <FormattedNumberCell format={NUMBER_FORMAT} value={value} />
);

// Source reads as one of three provenances, all rendered with the shared
// outline chip (matching the Repository cells): a repo the component is
// committed to (shared/ambiguous ownership), a plugin/pack it ships in, or an
// individual builder's un-committed local machine (labelled simply "Local").
const SourceCell = ({ component }: { component: AgentComponent }) => {
  if (component.sourceType === SourceType.Local) {
    return (
      <Chip className="min-w-0 gap-1" variant="outline">
        <LaptopIcon className="size-3 shrink-0" />
        Local
      </Chip>
    );
  }
  if (component.sourceType === SourceType.Pack) {
    return (
      <Chip className="min-w-0 gap-1" variant="outline">
        <PackageIcon className="size-3 shrink-0" />
        <span className="truncate">{component.source}</span>
      </Chip>
    );
  }
  return (
    <Chip className="min-w-0 gap-1" variant="outline">
      <FolderGit2Icon className="size-3 shrink-0" />
      <span className="truncate">{component.source}</span>
    </Chip>
  );
};

const NameLead = ({
  component,
  onSelect,
}: {
  component: AgentComponent;
  onSelect: (component: AgentComponent) => void;
}) => (
  <button
    className="cursor-pointer truncate text-left font-medium text-sm"
    onClick={() => onSelect(component)}
    type="button"
  >
    {component.name}
  </button>
);

const ActionsCell = () => (
  <div className="flex w-full items-center justify-end opacity-0 transition-opacity group-hover:opacity-100">
    <button
      aria-label="More actions"
      className="rounded-md p-1 text-muted-foreground hover:bg-muted"
      type="button"
    >
      <EllipsisIcon className="size-4" />
    </button>
  </div>
);

// -----------------------------------------------------------------------------
// Summary cards. Mirrors the desktop Sessions page: a horizontal row of
// fixed-width metric cards that sits inside the scroll container (above the
// table) and scrolls away as the table is scrolled. Values reflect the current
// filter set, like the Sessions summary cards.
// -----------------------------------------------------------------------------

const AgentsSummaryCards = ({
  components,
}: {
  components: readonly AgentComponent[];
}) => {
  const totalInvocations = components.reduce(
    (sum, component) => sum + (component.invocations ?? 0),
    0
  );
  const locPerDollarValues = components
    .map((component) => component.locPerDollar)
    .filter((value): value is number => value !== null);
  const avgLocPerDollar = locPerDollarValues.length
    ? locPerDollarValues.reduce((sum, value) => sum + value, 0) /
      locPerDollarValues.length
    : 0;
  const sources = new Set(components.map((component) => component.source)).size;

  const cards = [
    {
      key: "components",
      label: "Components",
      value: NUMBER_FORMAT.format(components.length),
      detail: "matched by the current filters",
      info: {
        what: "Agents, commands, and skills in the current view.",
        how: "Count of components in the active filter set.",
      },
    },
    {
      key: "invocations",
      label: "Invocations",
      value: NUMBER_FORMAT.format(totalInvocations),
      detail: "tool calls in range",
      info: {
        what: "Total tool calls attributed to these components.",
        how: "Sum of recorded invocations across the filtered set.",
      },
    },
    {
      key: "loc-per-dollar",
      label: "LOC / $",
      value: LOC_PER_DOLLAR_FORMAT.format(avgLocPerDollar),
      detail: "avg across components",
      info: {
        what: "Average merged lines per dollar across these components.",
        how: "Read this as a trend, not a score. It's a session-level metric, not caused by one component.",
      },
    },
    {
      key: "sources",
      label: "Sources",
      value: NUMBER_FORMAT.format(sources),
      detail: "repos, packs, and local",
      info: {
        what: "Distinct sources these components come from.",
        how: "A component has a source, not an owner. Counted across the filtered set.",
      },
    },
  ];

  return (
    <div className="flex gap-4">
      {cards.map((card) => (
        <MetricCard
          className="w-[260px] shrink-0"
          detail={card.detail}
          info={card.info}
          key={card.key}
          label={card.label}
          value={card.value}
        />
      ))}
    </div>
  );
};

// -----------------------------------------------------------------------------
// One shared table with type quick-filter tabs and a production-style Filter and
// View menu (group-by + column toggles).
// -----------------------------------------------------------------------------

const toggleValue = (previous: ReadonlySet<string>, value: string) => {
  const next = new Set(previous);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
};

export const AgentsGroupedList = ({
  kinds,
  onSelect,
}: {
  kinds: readonly AgentComponentKind[];
  onSelect: (component: AgentComponent) => void;
}) => {
  const [typeFilter, setTypeFilter] = useState<AgentComponentKind | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>(GroupBy.Type);
  const [hiddenColumns, setHiddenColumns] = useState<ReadonlySet<string>>(
    new Set()
  );
  const [sourceSel, setSourceSel] = useState<ReadonlySet<string>>(new Set());
  const [harnessSel, setHarnessSel] = useState<ReadonlySet<string>>(new Set());
  const [sortBy, setSortBy] = useState<string>(METRIC_COLUMN);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const inScope = mockComponents.filter((component) =>
    kinds.includes(component.kind)
  );

  const baseItems = inScope.filter(
    (component) =>
      (typeFilter === null || component.kind === typeFilter) &&
      (sourceSel.size === 0 || sourceSel.has(component.source)) &&
      (harnessSel.size === 0 || harnessSel.has(component.harness))
  );

  // Facet counts reflect the active type tab, not the source/harness
  // selections, so each option keeps a stable count as boxes are checked.
  const typeScoped = inScope.filter(
    (component) => typeFilter === null || component.kind === typeFilter
  );
  const sourceOptions: FilterOption[] = [
    ...new Set(inScope.map((component) => component.source)),
  ]
    .sort((a, b) => a.localeCompare(b))
    .map((source) => ({
      value: source,
      label: source,
      count: typeScoped.filter((component) => component.source === source)
        .length,
    }));
  const harnessOptions: FilterOption[] = HARNESS_ORDER.map((harness) => ({
    value: harness,
    label: HARNESS_META[harness].label,
    count: typeScoped.filter((component) => component.harness === harness)
      .length,
  }));

  const visibleColumns = COLUMN_DEFS.filter(
    (column) => !hiddenColumns.has(column.id)
  );
  const gridColumns: GridTableColumn[] = [
    ...visibleColumns.map((column) => ({
      id: column.id,
      label: column.label,
      sortable: true,
    })),
    // Shared row-actions spec: no visible header, never sortable, and named for
    // assistive tech so the label-less column is not a blank `columnheader`
    // (ISS-4672).
    ROW_ACTIONS_COLUMN,
  ];
  const gridTemplateColumns = [
    "minmax(240px,1fr)",
    ...visibleColumns.map((column) => column.width),
    "56px",
  ].join(" ");

  const viewColumns: ViewMenuColumn[] = COLUMN_DEFS.map((column) => ({
    id: column.id,
    label: column.label,
    icon: column.icon,
    visible: !hiddenColumns.has(column.id),
  }));

  const sortItems = (items: readonly AgentComponent[]) =>
    [...items].sort((a, b) => compareBy(a, b, sortBy, sortDir));

  // Hooks and Memory & config carry no usage logs, so grouping by Type puts
  // every LOC/$, Invocations, and Sessions cell in those groups at a dash. Say
  // that once on the group header instead of repeating the dash down every
  // row (checked against the real values, not the kind, so it only fires when
  // every row in the group actually has nothing to show).
  const usageNotTrackedSuffix = " (usage not tracked)";
  const isUsageTrackedGroup = (items: readonly AgentComponent[]): boolean =>
    items.some((component) => component.locPerDollar !== null);

  const isGrouped = groupBy !== GroupBy.None;
  const groups: GridTableGroup<AgentComponent>[] | undefined = isGrouped
    ? groupDefsFor(groupBy, kinds)
        .map((def) => {
          const items = sortItems(baseItems.filter(def.match));
          return {
            key: def.key,
            label: isUsageTrackedGroup(items)
              ? def.label
              : `${def.label}${usageNotTrackedSuffix}`,
            items,
          };
        })
        .filter((group) => group.items.length > 0)
    : undefined;
  const flatItems = isGrouped ? [] : sortItems(baseItems);
  const isEmpty = isGrouped ? groups?.length === 0 : flatItems.length === 0;

  const resetView = () => {
    setGroupBy(GroupBy.Type);
    setHiddenColumns(new Set());
    setSortBy(METRIC_COLUMN);
    setSortDir("desc");
  };

  const renderCell = (columnId: string, component: AgentComponent) => {
    switch (columnId) {
      case "type":
        return <KindBadge kind={component.kind} />;
      case METRIC_COLUMN:
        return <LocPerDollarCell value={component.locPerDollar} />;
      case "collaborators":
        return <CollaboratorStack users={collaboratorsFor(component)} />;
      case "source":
        return <SourceCell component={component} />;
      case "harness":
        return <HarnessBadge harness={component.harness} />;
      case "invocations":
        return <NumberCell value={component.invocations} />;
      case "sessions":
        return <NumberCell value={component.sessions} />;
      default:
        return <ActionsCell />;
    }
  };

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3">
        <div className="max-w-full overflow-x-auto">
          <ToggleGroup
            onValueChange={(value) => {
              if (value) {
                setTypeFilter(
                  value === ALL_TYPES ? null : (value as AgentComponentKind)
                );
              }
            }}
            type="single"
            value={typeFilter ?? ALL_TYPES}
            variant="outline"
          >
            <ToggleGroupItem aria-label="All" value={ALL_TYPES}>
              <LayersIcon className="size-4" />
              All
            </ToggleGroupItem>
            {kinds.map((kind) => {
              const Icon = KIND_META[kind].icon;
              return (
                <ToggleGroupItem
                  aria-label={KIND_META[kind].plural}
                  key={kind}
                  value={kind}
                >
                  <Icon className="size-4" />
                  {KIND_META[kind].plural}
                </ToggleGroupItem>
              );
            })}
          </ToggleGroup>
        </div>

        <AgentsFilterMenu
          harnessOptions={harnessOptions}
          harnessSelected={harnessSel}
          onToggleHarness={(value) =>
            setHarnessSel((prev) => toggleValue(prev, value))
          }
          onToggleSource={(value) =>
            setSourceSel((prev) => toggleValue(prev, value))
          }
          sourceOptions={sourceOptions}
          sourceSelected={sourceSel}
        />

        <AgentsViewMenu
          columns={viewColumns}
          groupBy={groupBy}
          groupByOptions={GROUP_BY_OPTIONS}
          onGroupByChange={(value) => setGroupBy(value as GroupBy)}
          onReset={resetView}
          onToggleColumn={(id) =>
            setHiddenColumns((prev) => toggleValue(prev, id))
          }
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex flex-col gap-4 px-4 pt-3 pb-4">
          <AgentsSummaryCards components={baseItems} />
        </div>
        {isEmpty ? (
          <p className="px-4 py-12 text-center text-muted-foreground text-sm">
            No components match the current filters.
          </p>
        ) : (
          <GridTable
            columns={gridColumns}
            getRowId={(component) => component.id}
            gridTemplateColumns={gridTemplateColumns}
            groups={groups}
            items={flatItems}
            leadingLabel="Component"
            leadingSortKey="name"
            onSort={(column, direction) => {
              setSortBy(column);
              setSortDir(direction);
            }}
            renderCell={renderCell}
            renderLead={(component) => (
              <NameLead component={component} onSelect={onSelect} />
            )}
            sortBy={sortBy}
            sortDir={sortDir}
          />
        )}
      </div>
    </>
  );
};
