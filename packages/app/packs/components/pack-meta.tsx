// Shared presentation for the unified Packs UX: content-kind metadata, harness
// labels, star formatting, and the small avatar stacks reused by the cards, the
// detail tabs, and the activity feed. Ported from the packs prototype and
// retyped onto the canonical `PackView` model.

import type { Harness } from "@repo/app/agents/lib/session-types";
import {
  BotIcon,
  HammerIcon,
  type LucideIcon,
  PackageIcon,
  PlugIcon,
  TerminalIcon,
  WebhookIcon,
  WrenchIcon,
} from "lucide-react";
import {
  CONTENT_KIND_ORDER,
  PackContentKind,
  type PackUser,
  type PackView,
} from "../lib/pack-view";

type ContentKindMeta = {
  icon: LucideIcon;
  label: string;
  plural: string;
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
    iconColor: "text-blue-600 dark:text-blue-400",
    iconBg: "bg-blue-500/10",
  },
  [PackContentKind.Skill]: {
    icon: WrenchIcon,
    label: "Skill",
    plural: "Skills",
    iconColor: "text-violet-600 dark:text-violet-400",
    iconBg: "bg-violet-500/10",
  },
  [PackContentKind.Command]: {
    icon: TerminalIcon,
    label: "Command",
    plural: "Commands",
    iconColor: "text-emerald-600 dark:text-emerald-400",
    iconBg: "bg-emerald-500/10",
  },
  [PackContentKind.Hook]: {
    icon: WebhookIcon,
    label: "Hook",
    plural: "Hooks",
    iconColor: "text-amber-600 dark:text-amber-400",
    iconBg: "bg-amber-500/10",
  },
  [PackContentKind.Mcp]: {
    icon: PlugIcon,
    label: "MCP tool",
    plural: "MCP tools",
    iconColor: "text-rose-600 dark:text-rose-400",
    iconBg: "bg-rose-500/10",
  },
  [PackContentKind.Plugin]: {
    icon: PackageIcon,
    label: "Plugin",
    plural: "Plugins",
    iconColor: "text-sky-600 dark:text-sky-400",
    iconBg: "bg-sky-500/10",
  },
  [PackContentKind.Tool]: {
    icon: HammerIcon,
    label: "Tool",
    plural: "Tools",
    iconColor: "text-slate-600 dark:text-slate-400",
    iconBg: "bg-slate-500/10",
  },
};

const HARNESS_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  copilot: "Copilot",
  opencode: "OpenCode",
};

/** Human label for a harness id, capitalizing unknown values. */
export function harnessLabel(harness: Harness): string {
  return (
    HARNESS_LABELS[harness] ??
    harness.charAt(0).toUpperCase() + harness.slice(1)
  );
}

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

export function formatStars(stars: number | null | undefined): string {
  if (stars == null) {
    return "—";
  }
  if (stars >= 1000) {
    return `${(stars / 1000).toFixed(1)}k`;
  }
  return NUMBER_FORMAT.format(stars);
}

// A stable fallback accent color derived from a seed (used when a PackUser has
// no color of its own), so avatars stay consistent across renders.
const FALLBACK_COLORS = [
  "#e11d48",
  "#6366f1",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#0891b2",
  "#db2777",
  "#2563eb",
];

export function stableUserColor(
  user: Pick<PackUser, "id" | "name" | "color">
): string {
  if (user.color) {
    return user.color;
  }
  const seed = user.id || user.name;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 2_147_483_647;
  }
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

// An overlapping avatar stack of the members who installed a pack.
export const InstallerStack = ({
  users,
  max = 5,
}: {
  users: readonly PackUser[];
  max?: number;
}) => {
  const shown = users.slice(0, max);
  const extra = users.length - shown.length;
  return (
    <div className="flex items-center">
      {shown.map((user, index) => (
        <span
          className="-ml-1.5 flex size-6 items-center justify-center rounded-full border-2 border-background font-medium text-[9px] text-white first:ml-0"
          key={user.id}
          style={{
            backgroundColor: stableUserColor(user),
            zIndex: shown.length - index,
          }}
          title={user.name}
        >
          {user.initials}
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

// An avatar chip + name for a single member, reused by the "used by" list and
// the activity feed. `muted` renders the member as disabled (grayscale avatar,
// muted text) for the "not installed" roster.
export const UserPill = ({
  user,
  muted = false,
}: {
  user: PackUser;
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
      style={{ backgroundColor: stableUserColor(user) }}
    >
      {user.initials}
    </span>
    <span className="truncate">{user.name}</span>
  </span>
);

/**
 * Compact "3 agents · 5 skills · 1 hook" summary shown on each card. Only counts
 * the kinds visible in the current surface (`visibleKinds`).
 */
export function contentSummary(
  pack: PackView,
  visibleKinds: readonly PackContentKind[] = CONTENT_KIND_ORDER
): string {
  return visibleKinds
    .map((kind) => {
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
}

/** The content kinds a surface should render, given its extended-kinds flag. */
export function visibleContentKinds(
  showExtended: boolean
): readonly PackContentKind[] {
  return showExtended
    ? CONTENT_KIND_ORDER
    : CONTENT_KIND_ORDER.filter(
        (kind) =>
          kind !== PackContentKind.Plugin && kind !== PackContentKind.Tool
      );
}
