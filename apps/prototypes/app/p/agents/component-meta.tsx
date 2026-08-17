// Shared presentation for the Agents inventory: kind/harness/source metadata
// and the small chips reused by both the list table and the detail page.

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
} from "lucide-react";
import type { ComponentProps } from "react";
import {
  type AgentComponent,
  AgentComponentKind,
  Harness,
  SourceType,
  USER_COLORS,
} from "./mock";

export type BadgeVariant = ComponentProps<typeof Badge>["variant"];

type KindMeta = {
  icon: LucideIcon;
  label: string;
  plural: string;
  variant: BadgeVariant;
};

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
};

export const KIND_ORDER: readonly AgentComponentKind[] = [
  AgentComponentKind.Subagent,
  AgentComponentKind.Command,
  AgentComponentKind.Skill,
  AgentComponentKind.Workflow,
  AgentComponentKind.Mcp,
  AgentComponentKind.Hook,
  AgentComponentKind.Config,
];

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

export const PACK_COLORS: Record<string, string> = {
  code: "#41A3FF",
  "code-review": "#6366F1",
  bootstrap: "#1F8A5B",
  platform: "#C08A2F",
  "self-learning": "#8B5CF6",
};

const SOURCE_ICON: Record<
  Exclude<SourceType, "pack">,
  { icon: LucideIcon; title: string }
> = {
  [SourceType.Repo]: { icon: FolderGitIcon, title: "Checked into a repo" },
  [SourceType.Local]: { icon: HardDriveIcon, title: "Local, builder-specific" },
  [SourceType.Server]: { icon: PlugIcon, title: "MCP server" },
  [SourceType.Scope]: { icon: LayersIcon, title: "Config scope" },
};

// ISS-4667: a merged-LOC-per-dollar of 4,100 is the un-pack baseline (the
// same relative position as the pre-ISS-4667 4.1 KLOC/$).
//
// Per design review the summary card already says to read LOC/$ as a trend,
// not a score, so a per-row tone would contradict its own copy (and with the
// current mock set the scale barely does any work — most rows land in one
// band). The value renders plain everywhere; the baseline lives in the list
// column's header instead of a per-row judgment call.
export const LOC_PER_DOLLAR_BASELINE = 4100;

export const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

// LOC/$ lands in the thousands, and past the leading digit or two the rest is
// noise on a directional metric. Compact notation (8.1K) keeps the column
// narrow and the digits that actually move up front, and — because it pins a
// single fraction digit — the averaged summary value stops landing on a
// different hundredths-of-a-line fraction every time a filter changes. This is
// the one exported formatter every LOC/$ surface (list column, list summary
// card, detail metric card) reads from, so the same value never renders two
// shapes.
export const LOC_PER_DOLLAR_FORMAT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

// The list column's header states the baseline directly (design review: put
// the comparison in the header, not a per-row tone). Derived from the same
// baseline + formatter the column value uses, so the stated number can never
// drift from what the column actually renders.
export const LOC_PER_DOLLAR_COLUMN_LABEL = `LOC / $ vs ${LOC_PER_DOLLAR_FORMAT.format(
  LOC_PER_DOLLAR_BASELINE
)}`;

export const KindBadge = ({ kind }: { kind: AgentComponentKind }) => (
  <Badge variant={KIND_META[kind].variant}>{KIND_META[kind].label}</Badge>
);

export const HarnessBadge = ({ harness }: { harness: Harness }) => (
  <Badge variant={HARNESS_META[harness].variant}>
    {HARNESS_META[harness].label}
  </Badge>
);

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
  const meta = SOURCE_ICON[component.sourceType];
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

const initialsOf = (name: string): string =>
  name
    .split(" ")
    .map((part) => part.charAt(0))
    .join("")
    .slice(0, 2);

// The usage-derived Collaborators stack: an avatar cluster of the team members
// who have used a component. Not authorship — a component has a source, not an
// owner (PRD-519).
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

// An avatar chip + name for a single person, reused by the Owner cells on the
// Sessions and Branches usage tables (usage rows have real owners; components do
// not — see PRD-519).
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
