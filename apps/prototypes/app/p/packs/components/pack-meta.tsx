// Shared presentation for the Packs page: content-kind metadata, harness
// labels, and the small avatar stacks reused by the cards and detail dialog.

import { Badge } from "@repo/design-system/components/ui/badge";
import {
  BotIcon,
  GlobeIcon,
  LockIcon,
  type LucideIcon,
  PlugIcon,
  TerminalIcon,
  WebhookIcon,
  WrenchIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import {
  Harness,
  type Pack,
  PackContentKind,
  PackVisibility,
  USER_COLORS,
} from "../mock";

export type BadgeVariant = ComponentProps<typeof Badge>["variant"];

type ContentKindMeta = {
  icon: LucideIcon;
  label: string;
  plural: string;
  variant: BadgeVariant;
  /** Icon foreground color. */
  iconColor: string;
  /** ~10% tint of the icon color used behind the icon. */
  iconBg: string;
};

export const CONTENT_KIND_META: Record<PackContentKind, ContentKindMeta> = {
  [PackContentKind.Agent]: {
    icon: BotIcon,
    label: "Agent",
    plural: "Agents",
    variant: "accent",
    iconColor: "text-blue-600 dark:text-blue-400",
    iconBg: "bg-blue-500/10",
  },
  [PackContentKind.Skill]: {
    icon: WrenchIcon,
    label: "Skill",
    plural: "Skills",
    variant: "info",
    iconColor: "text-violet-600 dark:text-violet-400",
    iconBg: "bg-violet-500/10",
  },
  [PackContentKind.Command]: {
    icon: TerminalIcon,
    label: "Command",
    plural: "Commands",
    variant: "secondary",
    iconColor: "text-emerald-600 dark:text-emerald-400",
    iconBg: "bg-emerald-500/10",
  },
  [PackContentKind.Hook]: {
    icon: WebhookIcon,
    label: "Hook",
    plural: "Hooks",
    variant: "muted",
    iconColor: "text-amber-600 dark:text-amber-400",
    iconBg: "bg-amber-500/10",
  },
  [PackContentKind.Mcp]: {
    icon: PlugIcon,
    label: "MCP tool",
    plural: "MCP tools",
    variant: "warning",
    iconColor: "text-rose-600 dark:text-rose-400",
    iconBg: "bg-rose-500/10",
  },
};

// Order the content kinds render in, across summary chips and the detail tabs.
export const CONTENT_KIND_ORDER: readonly PackContentKind[] = [
  PackContentKind.Agent,
  PackContentKind.Skill,
  PackContentKind.Command,
  PackContentKind.Hook,
  PackContentKind.Mcp,
];

export const HARNESS_LABEL: Record<Harness, string> = {
  [Harness.Claude]: "Claude",
  [Harness.Codex]: "Codex",
  [Harness.Both]: "Claude + Codex",
};

export const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

export const formatStars = (stars: number): string => {
  if (stars >= 1000) {
    return `${(stars / 1000).toFixed(1)}k`;
  }
  return NUMBER_FORMAT.format(stars);
};

const initialsOf = (name: string): string =>
  name
    .split(" ")
    .map((part) => part.charAt(0))
    .join("")
    .slice(0, 2);

// An overlapping avatar stack of the members who installed a pack. `trailing`
// (the Team usage "View all" link) renders AFTER the "+N" overflow chip rather
// than replacing it. Suppressing the count would hide how many people the stack
// is not showing, which is the one thing the overflow is there to say.
export const InstallerStack = ({
  users,
  max = 5,
  trailing,
  size = "md",
}: {
  users: readonly string[];
  max?: number;
  trailing?: ReactNode;
  size?: "md" | "lg";
}) => {
  const shown = users.slice(0, max);
  const extra = users.length - shown.length;
  const dims =
    size === "lg" ? "-ml-2 size-8 text-[11px]" : "-ml-1.5 size-6 text-[9px]";
  return (
    <div className="flex items-center">
      {shown.map((user, index) => (
        <span
          className={`flex items-center justify-center rounded-full border-2 border-background font-medium text-white first:ml-0 ${dims}`}
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
      {extra === 0 ? null : (
        <span
          className={`flex items-center justify-center rounded-full border-2 border-background bg-muted font-medium text-muted-foreground ${dims}`}
        >
          +{extra}
        </span>
      )}
      {trailing}
    </div>
  );
};

// An avatar chip + name for a single member, reused by the "used by" list and
// the activity feed. `muted` renders the member as disabled (grayscale avatar,
// muted text) for the "not installed" roster.
export const UserPill = ({
  name,
  muted = false,
}: {
  name: string;
  muted?: boolean;
}) => (
  <span
    className={`flex min-w-0 items-center gap-2 text-sm ${
      muted ? "text-muted-foreground" : ""
    }`}
  >
    <span
      aria-hidden="true"
      className={`flex size-5 shrink-0 items-center justify-center rounded-full font-medium text-[10px] text-white ${
        muted ? "opacity-60 grayscale" : ""
      }`}
      style={{ backgroundColor: USER_COLORS[name] ?? "#94a3b8" }}
    >
      {initialsOf(name)}
    </span>
    <span className="truncate">{name}</span>
  </span>
);

// Shared styling for the neutral metadata tags in the detail header and cards:
// white background, normal border, muted-foreground text, regular weight.
export const META_BADGE_CLASS =
  "border-border bg-background font-normal text-muted-foreground";

// Public/private listing chip, shown beside the stars on cards and detail.
export const VisibilityBadge = ({
  visibility,
}: {
  visibility: PackVisibility;
}) => {
  const isPublic = visibility === PackVisibility.Public;
  const Icon = isPublic ? GlobeIcon : LockIcon;
  return (
    <Badge className={`gap-1 ${META_BADGE_CLASS}`} variant="outline">
      <Icon className="size-3" />
      {isPublic ? "Public" : "Private"}
    </Badge>
  );
};

// A content-kind chip (Agent/Skill/Command/Hook/MCP tool) with its colored icon,
// reused by the Contents table.
export const KindBadge = ({ kind }: { kind: PackContentKind }) => {
  const meta = CONTENT_KIND_META[kind];
  const Icon = meta.icon;
  return (
    <Badge className="gap-1" variant="muted">
      <Icon className={`size-3 ${meta.iconColor}`} />
      {meta.label}
    </Badge>
  );
};

// The compact "3 agents · 5 skills · 1 hook" summary shown on each card.
export const contentSummary = (pack: Pack): string =>
  CONTENT_KIND_ORDER.map((kind) => {
    const count = pack.contents.filter((item) => item.kind === kind).length;
    if (count === 0) {
      return null;
    }
    const meta = CONTENT_KIND_META[kind];
    const label = count === 1 ? meta.label : meta.plural;
    return `${count} ${label.toLowerCase()}`;
  })
    .filter((part): part is string => part !== null)
    .join(" · ");
