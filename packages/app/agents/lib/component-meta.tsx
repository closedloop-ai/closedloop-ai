"use client";

/**
 * Runtime / presentation helpers for the Agents workspace inventory.
 *
 * KIND_META, HARNESS_META, KIND_ORDER, badge/color helpers, KindBadge,
 * CollaboratorStack, SourceLabel, locPerDollarToneClass, etc.
 *
 * `"use client"` because this module exports components and, as of ISS-5009,
 * `SourceLabel` reads a React hook (`useFeatureFlagEnabledOptional`) — see
 * packages/app/AGENTS.md ("Components, hooks, and providers need `use client`").
 *
 * All enum types (AgentComponentKind, Harness, SourceType) and the
 * AgentComponent shape are imported from @repo/api — do NOT redeclare them.
 *
 * Generic primitives from @repo/design-system only; no domain-specific
 * components go into @repo/design-system (see design-system AGENTS.md).
 */

import {
  type AgentComponent,
  AgentComponentKind,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { labelize } from "@repo/api/src/utils/string";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import type { BadgeProps } from "@repo/design-system/components/ui/badge";
import { Badge } from "@repo/design-system/components/ui/badge";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import {
  BookMarkedIcon,
  BotIcon,
  FolderGitIcon,
  HammerIcon,
  HardDriveIcon,
  LayersIcon,
  type LucideIcon,
  NetworkIcon,
  PlugIcon,
  TerminalIcon,
  WebhookIcon,
  WorkflowIcon,
  WrenchIcon,
} from "lucide-react";
import { AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY } from "../../shared/lib/feature-flags";

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
    // Type-column badge stays "MCP tool"; the plural (tab strip + group-by-Type
    // header) is "MCPs" — matching the FEA-4019 PR title and keeping it visually
    // distinct from the adjacent "Tools" tab so the two don't read as a
    // prefix-only pair.
    label: "MCP tool",
    plural: "MCPs",
    variant: "warning",
  },
  [AgentComponentKind.Hook]: {
    icon: WebhookIcon,
    label: "Hook",
    plural: "Hooks",
    // FEA-4019: Hook is now a first-class top-level tab alongside Tool and
    // Orchestration, which both render `muted`. Give Hook its own `success`
    // variant so the three no longer read as one grey thing in the Type column
    // and group-by-Type headers.
    variant: "success",
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
  // FEA-2642: agent-runtime / harness tools (ToolSearch, Monitor, Workflow,
  // ExitPlanMode, ScheduleWakeup, Cron*, …). Observable-only sibling of `Tool`
  // — parser classifies them `kind:"harness"`, the desktop rollup buckets them
  // as `component_kind='orchestration'`. NOT admin-distributable (see
  // isPromotableKind / isObservedKind).
  [AgentComponentKind.Orchestration]: {
    icon: NetworkIcon,
    label: "Orchestration",
    plural: "Orchestration",
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
  AgentComponentKind.Orchestration,
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
  // `muted` (not `warning`): amber reads as a caution state and collided with
  // both the `danger` tone the Sessions HarnessBadge used and Kris's caution
  // color. A harness name is not an error/warning — `muted` says "a third
  // harness" honestly (T8). Kept in sync with `harnessConfig` in
  // session-status-badges.tsx.
  [Harness.Opencode]: { label: "OpenCode", variant: "muted" },
  // `Both` is the "used across harnesses" collapse — `resolveComponentHarness`
  // returns it whenever a component's usage spans more than one harness, which
  // now includes Claude+OpenCode, not only Claude+Codex. "Claude + Codex" would
  // name a harness the component never touched, so the label is the honest
  // "Multiple harnesses" (T3/T9). Same string in HARNESS_LABEL
  // (agent-component-sort-group.ts).
  [Harness.Both]: { label: "Multiple harnesses", variant: "info" },
};

// ---------------------------------------------------------------------------
// PACK_COLORS — stable accent color per pack name (used by SourceLabel)
// ---------------------------------------------------------------------------

const PACK_COLORS: Record<string, string> = {
  code: "#41A3FF",
  "code-review": "#6366F1",
  bootstrap: "#1F8A5B",
  platform: "#C08A2F",
  "self-learning": "#8B5CF6",
};

// ---------------------------------------------------------------------------
// USER_COLORS — stable accent color per display name (CollaboratorStack/UserPill)
// ---------------------------------------------------------------------------

const USER_COLORS: Record<string, string> = {
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
 * Kinds that carry a text prompt/definition — the only kinds whose detail page
 * renders the read-only Prompt panel (and, with it, the per-revision version
 * selector). SSOT for the panel gate in `agent-detail.tsx` AND the catalog
 * "N versions" signal in `agents-table.tsx`, so the two cannot drift.
 */
export const PROMPT_KINDS: ReadonlySet<AgentComponentKind> =
  new Set<AgentComponentKind>([
    AgentComponentKind.Subagent,
    AgentComponentKind.Command,
    AgentComponentKind.Skill,
  ]);

/**
 * FEA-4267: whether a component's detail page actually surfaces a version
 * dropdown the user can navigate to. The Prompt panel — the only version
 * selector — renders only for a prompt-carrying kind (subagent/command/skill)
 * that is also observed (has a captured revision history). A collapsed-family
 * row of any OTHER kind (mcp/tool/hook/workflow/config/plugin/orchestration)
 * lands the user on a detail page with no version affordance, so the catalog
 * must NOT promise "N versions" for it — a count with no destination sends the
 * user hunting for something that is not there. Gate the list-row signal on
 * exactly the same predicate as the panel so a count always has a destination.
 */
export const hasVersionHistoryAffordance = (
  kind: AgentComponentKind
): boolean => PROMPT_KINDS.has(kind) && isObservedKind(kind);

/**
 * FEA-3048: built-in `Tool` (Read/Grep/Bash …) and `Config` (memory & config)
 * are inventory/usage-only — observable but NOT admin-distributable via the
 * catalog. Anything else can be promoted to a CatalogItem + Distribution. This
 * is the single UI source of truth mirrored by the server-side promote guard
 * (`NON_PROMOTABLE_KINDS` in agent-components/promote/service.ts); keep the two
 * in sync.
 */
export const isPromotableKind = (kind: AgentComponentKind): boolean =>
  kind !== AgentComponentKind.Tool &&
  kind !== AgentComponentKind.Config &&
  // FEA-2642: orchestration/harness tools are runtime primitives — observable,
  // never a distributable catalog item (same as Tool).
  kind !== AgentComponentKind.Orchestration;

/**
 * FEA-4017: whether an agentic component can be installed locally by any org
 * member (no admin gate). Only pack-sourced components map to a vetted local
 * pack id — `catalogInstall` resolves the install command from the local
 * `pack_catalog` row keyed by that id, so a component that did NOT come from a
 * pack (repo / local file / MCP server / config scope) has no vetted local
 * install command and the Install action is hidden, mirroring how Promote hides
 * for non-distributable kinds.
 *
 * Surface wrappers derive the concrete pack id from `component.source` (the pack
 * name) with their own `normalizePackId`; this predicate only decides whether
 * the Install affordance is offered at all, so it stays free of any surface
 * (Electron IPC / HTTP) dependency.
 */
export const isLocallyInstallable = (component: {
  sourceType: SourceType;
}): boolean => component.sourceType === SourceType.Pack;

// ---------------------------------------------------------------------------
// LOC/$ metric helpers
// ---------------------------------------------------------------------------
//
// ISS-5475: there is deliberately no per-row tone here. `locPerDollarToneClass`
// graded every LOC/$ figure emerald/amber/rose off a `LOC_PER_DOLLAR_BASELINE`
// of 4.1 that its own comment conceded was "prototype-derived, not measured" —
// and real catalog rows are ~1–3, so effectively every row rendered rose and the
// column read as a solid stripe of red. The prototype had already settled this
// (`apps/prototypes/app/p/agents/component-meta.tsx`): the summary card tells the
// reader to take LOC/$ as a trend rather than a score, so a per-row verdict
// contradicts the surface's own copy. The value now renders in the default
// foreground on every surface.
//
// The baseline was deleted outright rather than moved into the column header the
// way the prototype states it. The prototype's header can name its baseline
// because that number means something on its scale; production's 4.1 is an
// unmeasured figure that no real row reaches, so "LOC / $ vs 4.1" would only
// relocate the same uncalibrated judgment from the row to the header and leave
// every row reading as under the bar. The Metric column header keeps the
// canonical `LOC_PER_DOLLAR_LABEL` from `@repo/api/src/utils/loc-per-dollar`.

export const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

// ---------------------------------------------------------------------------
// Badge components
// ---------------------------------------------------------------------------

export const KindBadge = ({ kind }: { kind: AgentComponentKind }) => (
  <Badge variant={kindMeta(kind).variant}>{kindMeta(kind).label}</Badge>
);

/**
 * FEA-4032: one low-emphasis Type treatment for every component kind. The
 * canonical metadata supplies both the decorative icon and accessible label;
 * per-kind badge tones remain available to {@link KindBadge} and other callers.
 */
export const KindLabel = ({ kind }: { kind: AgentComponentKind }) => {
  const meta = kindMeta(kind);
  const Icon = meta.icon;

  return (
    <span className="flex min-w-0 items-center gap-1.5 font-medium text-muted-foreground text-xs">
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate">{meta.label}</span>
    </span>
  );
};

// ---------------------------------------------------------------------------
// StatusDot — shared pulsing status-signal primitive (FEA-3620)
// ---------------------------------------------------------------------------

/**
 * Tone → CSS color mapping for {@link StatusDot}. Each tone reads from a design
 * token (never a hard-coded hex) so the dots track the theme's status SSOT:
 *   • `active` — the live "invoked in the last hour" signal (primary accent).
 *   • `new`    — the "discovered in the last 7 days" signal (success/green),
 *                deliberately a DISTINCT color from `active` so the two read as
 *                differentiated members of the same dot family.
 * Extend this map (not the component) when a new lightweight status signal
 * wants the same dot language.
 */
const STATUS_DOT_TONE: Record<"active" | "new", string> = {
  active: "var(--primary)",
  new: "var(--success)",
};

export type StatusDotTone = keyof typeof STATUS_DOT_TONE;

/**
 * A small pulsing status dot — the shared visual language for lightweight
 * agentic status signals (FEA-3620). Both the "active in the last hour" and the
 * "newly discovered" indicators are this ONE component with a different `tone`,
 * rather than two ad-hoc spans. Reuses the shared `ob-pulse` opacity animation
 * (packages/app/styles.css) at a consistent `size-1.5`; `shrink-0` keeps it from
 * perturbing an adjacent name's truncation.
 *
 * Domain-coupled (agentic status semantics) → lives in this feature slice, NOT
 * in @repo/design-system (see design-system AGENTS.md).
 *
 * Presentational only; the caller supplies an accessible `label` (used for both
 * `aria-label` and the hover `title`) since these dots carry no visible text.
 */
export const StatusDot = ({
  tone,
  label,
  testId,
}: {
  tone: StatusDotTone;
  label: string;
  testId?: string;
}) => (
  <span
    aria-label={label}
    className="size-1.5 shrink-0 rounded-full"
    data-testid={testId}
    role="img"
    style={{
      backgroundColor: STATUS_DOT_TONE[tone],
      animation: "ob-pulse 1.1s ease-in-out infinite",
    }}
    title={label}
  />
);

// ---------------------------------------------------------------------------
// "New" dot — flags components discovered within the recent-discovery window
// ---------------------------------------------------------------------------

/** Window (ms) within which a component's `firstSeenAt` counts as newly discovered. */
const NEW_DISCOVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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
 * Pulsing "newly discovered" dot shown next to a component name when it was first
 * seen in the last {@link NEW_DISCOVERY_WINDOW_MS}. FEA-3620 unified this from a
 * text pill into the shared {@link StatusDot} (success tone) so it reads as the
 * same design family as the active dot; its meaning stays discoverable via the
 * tooltip/aria-label since the visible "New" text is gone.
 */
export const NewDot = () => (
  <StatusDot
    label="Discovered in the last 7 days"
    testId="agent-new-dot"
    tone="new"
  />
);

// ---------------------------------------------------------------------------
// Source label — pack dot + name, or icon + name for non-pack sources
// ---------------------------------------------------------------------------

/**
 * ISS-5009: the hover/assistive explanation attached to the em-dash a Source
 * cell renders when the producer found no real provenance. `GridEmptyValue`
 * takes no props, so the wrapper carries the explanation — without it the em
 * dash is an unexplained blank and the cell trades one silent lie for another.
 * Shared with the detail page's Properties "Source" row so the catalog and the
 * detail cannot describe the same absence in two different words.
 */
export const NO_SOURCE_RECORDED_TITLE = "No source recorded";

/**
 * The Source cell's visible content for a KNOWN `{value, sourceType}` pair: a
 * pack renders its stable accent dot, everything else its source-type icon and
 * hover title. Extracted so the legacy pair and the ISS-5009 honest pair render
 * through ONE structure — a second copy is how the two would drift into
 * different truncation, spacing, or glyph rules.
 */
const SourceValue = ({
  source,
  sourceType,
}: {
  source: string;
  sourceType: SourceType;
}) => {
  if (sourceType === SourceType.Pack) {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-sm">
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: PACK_COLORS[source] ?? "#94a3b8" }}
        />
        <span className="truncate">{source}</span>
      </span>
    );
  }
  const meta = SOURCE_ICON[sourceType as Exclude<SourceType, "pack">];
  const Icon = meta.icon;
  return (
    <span
      className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-sm"
      title={meta.title}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{source}</span>
    </span>
  );
};

/**
 * The Agents catalog Source cell.
 *
 * ISS-5009 gates the honest projection behind
 * {@link AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY}. With the flag OFF — or
 * against a server that predates the field and therefore omits `honestSource` —
 * this renders exactly what it always has, from `component.source` and
 * `component.sourceType`. NOTHING from the honest projection (not the value, not
 * the glyph) is read outside the flag-on branch: leaking the corrected glyph to
 * a flag-off viewer is precisely the closed-by-default violation the flag exists
 * to prevent.
 *
 * Read via `useFeatureFlagEnabledOptional`, never the throwing variant:
 * `AgentsTable` mounts in Storybook and in mini-table tests with no
 * `FeatureFlagAdapterProvider`, where the throwing hook would take the whole
 * subtree down rather than resolving the flag to its closed default.
 *
 * A `hasProvenance: true` paired with a `null` value is a self-contradictory
 * payload no producer should emit; it degrades to the same honest em dash rather
 * than rendering an empty label that would read as a source with no name.
 */
export const SourceLabel = ({ component }: { component: AgentComponent }) => {
  const provenanceHonestyEnabled = useFeatureFlagEnabledOptional(
    AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY
  );
  const honest = component.honestSource;

  if (provenanceHonestyEnabled && honest) {
    if (honest.hasProvenance && honest.source !== null) {
      return (
        <SourceValue source={honest.source} sourceType={honest.sourceType} />
      );
    }
    return <GridEmptyValue title={NO_SOURCE_RECORDED_TITLE} />;
  }

  return (
    <SourceValue source={component.source} sourceType={component.sourceType} />
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
 *
 * FEA-4098 (Slice 3): this now renders the authors people-set (discoverer +
 * editors). An empty set is honest, not a bug (a legacy/unlinked row has no
 * lineage), so it renders a plain em dash rather than a silent blank — the UI
 * never lies about "no known authors". The overlapping chips carry the author
 * names as an accessible group label (WCAG 1.1.1 / 4.1.2), so a screen reader
 * announces who authored the component, not a wall of initials.
 *
 * FEA-4247: with the read-time owner fallback the common case is exactly one
 * author, and an initials circle hides that single name behind a hover title.
 * `singleAsText` renders a lone author as plain text so a detail row reads like
 * its plain-text neighbours (Type, Source, Harness) instead of being the one
 * field you have to hover to read; the overlapping stack is kept for 2+, where
 * the chips earn their overlap. The compact table column omits `singleAsText`
 * and keeps the avatar for every count.
 */
export const CollaboratorStack = ({
  users,
  max = 4,
  singleAsText = false,
}: {
  users: readonly string[];
  max?: number;
  singleAsText?: boolean;
}) => {
  if (users.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (singleAsText && users.length === 1) {
    return <span className="truncate">{users[0]}</span>;
  }
  const shown = users.slice(0, max);
  const extra = users.length - shown.length;
  return (
    // The overlapping initials are decorative (aria-hidden); the stack as a whole
    // is one labelled image announcing the author names, so a screen reader reads
    // "Dana Discoverer, Edith Editor" rather than a run of loose initials.
    <div aria-label={users.join(", ")} className="flex items-center" role="img">
      {shown.map((user, index) => (
        <span
          aria-hidden="true"
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
        <span
          aria-hidden="true"
          className="-ml-1.5 flex size-6 items-center justify-center rounded-full border-2 border-background bg-muted font-medium text-[9px] text-muted-foreground"
        >
          +{extra}
        </span>
      ) : null}
    </div>
  );
};

// FEA-4098 (Slice 3): `OwnerLabel` and its single-person `UserPill` were removed
// with the Owner column. Authorship is now the `collaborators` people-set
// rendered by `CollaboratorStack` (discoverer + editors, avatar stack). The
// Connect-GitHub owner CTA (FEA-2923) went with them — authorship no longer
// depends on a GitHub connection.

// ---------------------------------------------------------------------------
// Metric value cell
// ---------------------------------------------------------------------------
//
// `LocPerDollarColumnValue` moved to
// `../components/workspace/loc-per-dollar-cell.tsx` (review cid 3701349992) so
// its visual states can carry a Storybook canvas — Storybook only scans
// component directories, not `lib/`. Nothing LOC/$-tone-related is left here:
// ISS-5475 deleted the tone vocabulary along with its baseline (see the LOC/$
// metric helpers section above).
