/**
 * Runtime / presentation helpers for the Agents workspace inventory.
 *
 * KIND_META, HARNESS_META, KIND_ORDER, badge/color helpers, KindBadge,
 * CollaboratorStack, OwnerLabel, SourceLabel, UserPill, KlocValue, etc.
 *
 * All enum types (AgentComponentKind, Harness, SourceType) and the
 * AgentComponent shape are imported from @repo/api — do NOT redeclare them.
 *
 * Generic primitives from @repo/design-system only; no domain-specific
 * components go into @repo/design-system (see design-system CLAUDE.md).
 */

import {
  type AgentComponent,
  AgentComponentKind,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { labelize } from "@repo/api/src/utils/string";
import type { BadgeProps } from "@repo/design-system/components/ui/badge";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  BookMarkedIcon,
  BotIcon,
  FolderGitIcon,
  HammerIcon,
  HardDriveIcon,
  LayersIcon,
  type LucideIcon,
  PlugIcon,
  TerminalIcon,
  WebhookIcon,
  WorkflowIcon,
  WrenchIcon,
} from "lucide-react";
import { ConnectGitHubIndicator } from "../../branches/components/connect-github-indicator";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BadgeVariant = BadgeProps["variant"];

type KindMeta = {
  icon: LucideIcon;
  label: string;
  plural: string;
  variant: BadgeVariant;
};

// ---------------------------------------------------------------------------
// KIND_META — one entry per AgentComponentKind
// ---------------------------------------------------------------------------

export const KIND_META: Record<AgentComponentKind, KindMeta> = {
  [AgentComponentKind.Subagent]: {
    icon: BotIcon,
    label: "Agent",
    plural: "Agents",
    variant: "accent",
  },
  [AgentComponentKind.Command]: {
    icon: TerminalIcon,
    label: "Command",
    plural: "Commands",
    variant: "secondary",
  },
  [AgentComponentKind.Skill]: {
    icon: HammerIcon,
    label: "Skill",
    plural: "Skills",
    variant: "info",
  },
  [AgentComponentKind.Workflow]: {
    icon: WorkflowIcon,
    label: "Workflow",
    plural: "Workflows",
    variant: "default",
  },
  [AgentComponentKind.Mcp]: {
    icon: PlugIcon,
    label: "MCP tool",
    plural: "MCP tools",
    variant: "warning",
  },
  [AgentComponentKind.Hook]: {
    icon: WebhookIcon,
    label: "Hook",
    plural: "Hooks",
    variant: "muted",
  },
  [AgentComponentKind.Config]: {
    icon: BookMarkedIcon,
    label: "Memory & config",
    plural: "Memory & config",
    variant: "outline",
  },
  [AgentComponentKind.Plugin]: {
    icon: LayersIcon,
    label: "Plugin",
    plural: "Plugins",
    variant: "secondary",
  },
  // FEA-3048: built-in CLI tools (Read/Grep/Glob/Edit/Bash …). Observable-only
  // — rendered as its own "Tool" kind, never coerced to "Memory & config", but
  // NOT promoted/distributed via the catalog (see isObservedKind, which
  // deliberately excludes it).
  [AgentComponentKind.Tool]: {
    icon: WrenchIcon,
    label: "Tool",
    plural: "Tools",
    variant: "muted",
  },
};

// Fallback for a component `kind` not present in KIND_META. As of FEA-3048
// `tool` IS a mapped kind, but the desktop collectors can still emit a kind
// that is NOT in the AgentComponentKind enum (a future collector variant), and
// the cloud syncs it, so the web workspace can receive an unmapped kind.
// Rendering `KIND_META[kind].icon`/`.label` directly then crashes the whole
// Agents page (undefined deref). Always resolve through kindMeta() so an unknown
// kind gets a sane, labelized badge instead of taking the page down.
export function kindMeta(kind: string): KindMeta {
  const known = KIND_META[kind as AgentComponentKind];
  if (known) {
    return known;
  }
  const label = labelize(kind);
  return {
    icon: HardDriveIcon,
    label,
    plural: `${label}s`,
    variant: "outline",
  };
}

// ---------------------------------------------------------------------------
// KIND_ORDER — canonical display order for AgentComponentKind values
// ---------------------------------------------------------------------------

export const KIND_ORDER: readonly AgentComponentKind[] = [
  AgentComponentKind.Subagent,
  AgentComponentKind.Command,
  AgentComponentKind.Skill,
  AgentComponentKind.Workflow,
  AgentComponentKind.Plugin,
  AgentComponentKind.Mcp,
  AgentComponentKind.Tool,
  AgentComponentKind.Hook,
  AgentComponentKind.Config,
];

// ---------------------------------------------------------------------------
// HARNESS_META — label and badge variant per Harness value
// ---------------------------------------------------------------------------

export const HARNESS_META: Record<
  Harness,
  { label: string; variant: BadgeVariant }
> = {
  [Harness.Claude]: { label: "Claude", variant: "accent" },
  [Harness.Codex]: { label: "Codex", variant: "secondary" },
  [Harness.Both]: { label: "Claude + Codex", variant: "info" },
};

export const HARNESS_ORDER: readonly Harness[] = [
  Harness.Both,
  Harness.Claude,
  Harness.Codex,
];

// ---------------------------------------------------------------------------
// PACK_COLORS — stable accent color per pack name (used by SourceLabel)
// ---------------------------------------------------------------------------

export const PACK_COLORS: Record<string, string> = {
  code: "#41A3FF",
  "code-review": "#6366F1",
  bootstrap: "#1F8A5B",
  platform: "#C08A2F",
  "self-learning": "#8B5CF6",
};

// ---------------------------------------------------------------------------
// USER_COLORS — stable accent color per display name (CollaboratorStack/UserPill)
// ---------------------------------------------------------------------------

export const USER_COLORS: Record<string, string> = {
  "Maya Chen": "#e11d48",
  "Devon Park": "#6366f1",
  "Sasha Ortiz": "#10b981",
  "Imani Reid": "#f59e0b",
  "Kenji Tan": "#8b5cf6",
  "Ada Nunez": "#0891b2",
};

// ---------------------------------------------------------------------------
// SOURCE_ICON — icon + title per non-pack SourceType
// ---------------------------------------------------------------------------

const SOURCE_ICON: Record<
  Exclude<SourceType, "pack">,
  { icon: LucideIcon; title: string }
> = {
  [SourceType.Repo]: { icon: FolderGitIcon, title: "Checked into a repo" },
  [SourceType.Local]: { icon: HardDriveIcon, title: "Local, builder-specific" },
  [SourceType.Server]: { icon: PlugIcon, title: "MCP server" },
  [SourceType.Scope]: { icon: LayersIcon, title: "Config scope" },
};

// ---------------------------------------------------------------------------
// Kind predicate helpers
// ---------------------------------------------------------------------------

/**
 * Returns true for kinds that carry real invocation data sourced from session
 * logs (skill/command/subagent/workflow/mcp/plugin). Hook and Config have a
 * thin or absent invocation signal — their usage is derived on-read rather
 * than materialized — so they return false.
 *
 * Moved here from the deleted `agent-component-sample-data.ts` stub (T-9.2)
 * so production code can import it without pulling in mock/sample data.
 */
export const isObservedKind = (kind: AgentComponentKind): boolean =>
  kind === AgentComponentKind.Subagent ||
  kind === AgentComponentKind.Command ||
  kind === AgentComponentKind.Skill ||
  kind === AgentComponentKind.Workflow ||
  kind === AgentComponentKind.Mcp ||
  kind === AgentComponentKind.Plugin;

/**
 * FEA-3048: built-in `Tool` (Read/Grep/Bash …) and `Config` (memory & config)
 * are inventory/usage-only — observable but NOT admin-distributable via the
 * catalog. Anything else can be promoted to a CatalogItem + Distribution. This
 * is the single UI source of truth mirrored by the server-side promote guard
 * (`NON_PROMOTABLE_KINDS` in agent-components/promote/service.ts); keep the two
 * in sync.
 */
export const isPromotableKind = (kind: AgentComponentKind): boolean =>
  kind !== AgentComponentKind.Tool && kind !== AgentComponentKind.Config;

// ---------------------------------------------------------------------------
// KLOC metric helpers
// ---------------------------------------------------------------------------

/**
 * Un-pack baseline merged-KLOC-per-dollar value. The value metric renders as
 * an efficient/inefficient signal: green well above baseline, amber around it,
 * red below.
 */
export const KLOC_BASELINE = 4.1;

export const klocToneClass = (value: number): string => {
  if (value >= KLOC_BASELINE * 1.4) {
    return "text-emerald-600 dark:text-emerald-400";
  }
  if (value >= KLOC_BASELINE * 1.1) {
    return "text-amber-600 dark:text-amber-400";
  }
  return "text-rose-600 dark:text-rose-400";
};

export const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

// ---------------------------------------------------------------------------
// Badge components
// ---------------------------------------------------------------------------

export const KindBadge = ({ kind }: { kind: AgentComponentKind }) => (
  <Badge variant={kindMeta(kind).variant}>{kindMeta(kind).label}</Badge>
);

// ---------------------------------------------------------------------------
// "New" badge — flags components discovered within the recent-discovery window
// ---------------------------------------------------------------------------

/** Window (ms) within which a component's `firstSeenAt` counts as newly discovered. */
export const NEW_DISCOVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * True when `firstSeenAt` (ISO-8601) falls within the last
 * {@link NEW_DISCOVERY_WINDOW_MS} relative to `now`. Unparseable or future
 * timestamps are treated as not-new.
 */
export const isNewlyDiscovered = (
  firstSeenAt: string,
  now: number = Date.now()
): boolean => {
  const seen = Date.parse(firstSeenAt);
  if (Number.isNaN(seen)) {
    return false;
  }
  const age = now - seen;
  return age >= 0 && age <= NEW_DISCOVERY_WINDOW_MS;
};

/**
 * Subtle "New" chip shown next to a component name when it was discovered in the
 * last {@link NEW_DISCOVERY_WINDOW_MS}. Reuses the generic Badge primitive (same
 * pattern as {@link KindBadge}); accessible via title + aria-label.
 */
export const NewBadge = () => (
  <Badge
    aria-label="Discovered in the last 7 days"
    title="Discovered in the last 7 days"
    variant="success"
  >
    New
  </Badge>
);

// ---------------------------------------------------------------------------
// Source label — pack dot + name, or icon + name for non-pack sources
// ---------------------------------------------------------------------------

export const SourceLabel = ({ component }: { component: AgentComponent }) => {
  if (component.sourceType === SourceType.Pack) {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-sm">
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full"
          style={{
            backgroundColor: PACK_COLORS[component.source] ?? "#94a3b8",
          }}
        />
        <span className="truncate">{component.source}</span>
      </span>
    );
  }
  const meta = SOURCE_ICON[component.sourceType as Exclude<SourceType, "pack">];
  const Icon = meta.icon;
  return (
    <span
      className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-sm"
      title={meta.title}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{component.source}</span>
    </span>
  );
};

// ---------------------------------------------------------------------------
// Avatar helpers
// ---------------------------------------------------------------------------

const initialsOf = (name: string): string =>
  name
    .split(" ")
    .map((part) => part.charAt(0))
    .join("")
    .slice(0, 2);

/**
 * Overlapping avatar stack for a list of collaborator display names.
 */
export const CollaboratorStack = ({
  users,
  max = 4,
}: {
  users: readonly string[];
  max?: number;
}) => {
  const shown = users.slice(0, max);
  const extra = users.length - shown.length;
  return (
    <div className="flex items-center">
      {shown.map((user, index) => (
        <span
          className="-ml-1.5 flex size-6 items-center justify-center rounded-full border-2 border-background font-medium text-[9px] text-white first:ml-0"
          key={user}
          style={{
            backgroundColor: USER_COLORS[user] ?? "#8a8f98",
            zIndex: shown.length - index,
          }}
          title={user}
        >
          {initialsOf(user)}
        </span>
      ))}
      {extra > 0 ? (
        <span className="-ml-1.5 flex size-6 items-center justify-center rounded-full border-2 border-background bg-muted font-medium text-[9px] text-muted-foreground">
          +{extra}
        </span>
      ) : null}
    </div>
  );
};

/**
 * Avatar chip + name for a single person — reused by Owner cells across the
 * inventory, sessions, and branches tables.
 */
export const UserPill = ({ name }: { name: string }) => (
  <span className="flex min-w-0 items-center gap-2 text-sm">
    <span
      aria-hidden="true"
      className="flex size-5 shrink-0 items-center justify-center rounded-full font-medium text-[10px] text-white"
      style={{ backgroundColor: USER_COLORS[name] ?? "#94a3b8" }}
    >
      {initialsOf(name)}
    </span>
    <span className="truncate">{name}</span>
  </span>
);

/**
 * Renders owner as a UserPill when the component has an attributed owner.
 *
 * Owner attribution (git-identity → cloud user) requires a GitHub connection.
 * When `owner` is null we honor the governing design (FEA-2923): show the reused
 * Connect-GitHub CTA when GitHub data is NOT connected, and a plain "—"
 * (unattributed) once it IS connected — never a bare blank.
 *
 * The connection signal is threaded down from the surface adapter: web resolves
 * it via the insights github-connect helpers, desktop leaves it undefined so the
 * fallback is "—" (never the CTA). `undefined` (unknown) is treated as connected
 * so the CTA never flashes before the status query resolves.
 *
 * Uses AgentComponent.owner (server-side populated) rather than the prototype's
 * hash-derived ownerFor() — no runtime derivation needed.
 */
export const OwnerLabel = ({
  component,
  githubConnected,
  githubConnectHref,
}: {
  component: AgentComponent;
  /** Whether GitHub data is connected; undefined = unknown (treated connected). */
  githubConnected?: boolean;
  /** Hard-navigation connect target for the CTA (web only). */
  githubConnectHref?: string;
}) => {
  if (component.owner !== null) {
    return <UserPill name={component.owner} />;
  }
  // Unattributed AND GitHub not connected → surface the connect affordance.
  if (githubConnected === false) {
    return <ConnectGitHubIndicator compact connectHref={githubConnectHref} />;
  }
  // Connected (or unknown) but still unattributed → honest em dash.
  return <span className="text-muted-foreground">—</span>;
};

// ---------------------------------------------------------------------------
// Metric value cell
// ---------------------------------------------------------------------------

export const KlocValue = ({ value }: { value: number | null }) => {
  if (value === null) {
    return <span className="text-muted-foreground">—</span>;
  }
  return <span className={klocToneClass(value)}>{value.toFixed(1)}</span>;
};
