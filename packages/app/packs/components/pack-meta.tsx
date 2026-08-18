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
  CONTENT_KIND_LABEL,
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
    label: CONTENT_KIND_LABEL[PackContentKind.Agent],
    plural: "Agents",
    iconColor: "text-blue-600 dark:text-blue-400",
    iconBg: "bg-blue-500/10",
  },
  [PackContentKind.Skill]: {
    icon: WrenchIcon,
    label: CONTENT_KIND_LABEL[PackContentKind.Skill],
    plural: "Skills",
    iconColor: "text-violet-600 dark:text-violet-400",
    iconBg: "bg-violet-500/10",
  },
  [PackContentKind.Command]: {
    icon: TerminalIcon,
    label: CONTENT_KIND_LABEL[PackContentKind.Command],
    plural: "Commands",
    iconColor: "text-emerald-600 dark:text-emerald-400",
    iconBg: "bg-emerald-500/10",
  },
  [PackContentKind.Hook]: {
    icon: WebhookIcon,
    label: CONTENT_KIND_LABEL[PackContentKind.Hook],
    plural: "Hooks",
    iconColor: "text-amber-600 dark:text-amber-400",
    iconBg: "bg-amber-500/10",
  },
  [PackContentKind.Mcp]: {
    icon: PlugIcon,
    label: CONTENT_KIND_LABEL[PackContentKind.Mcp],
    plural: "MCP tools",
    iconColor: "text-rose-600 dark:text-rose-400",
    iconBg: "bg-rose-500/10",
  },
  [PackContentKind.Plugin]: {
    icon: PackageIcon,
    label: CONTENT_KIND_LABEL[PackContentKind.Plugin],
    plural: "Plugins",
    iconColor: "text-sky-600 dark:text-sky-400",
    iconBg: "bg-sky-500/10",
  },
  [PackContentKind.Tool]: {
    icon: HammerIcon,
    label: CONTENT_KIND_LABEL[PackContentKind.Tool],
    plural: "Tools",
    iconColor: "text-teal-600 dark:text-teal-400",
    iconBg: "bg-teal-500/10",
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
 * Cap on how many kind counts the card summary prints inline. A pack can bundle
 * all seven kinds; spelling out every one wraps the summary onto two or three
 * lines in a 350px grid card and — because the grid stretches — drags every card
 * in that row taller with it. So we print at most the first three present kinds
 * (in `CONTENT_KIND_ORDER`) and roll the rest into a "+N more" so the summary
 * stays on one line.
 */
const CONTENT_SUMMARY_MAX_KINDS = 3;

/**
 * Compact "3 agents · 5 skills · 1 hook" summary shown on each card, counting
 * every content kind a pack bundles (FEA-4132 graduated the extended kinds to
 * always-on, so there is no per-surface gate). Clamped to the first
 * `CONTENT_SUMMARY_MAX_KINDS` present kinds with a "+N more" tail so a pack that
 * carries many kinds can't wrap the summary onto extra lines and stretch the card.
 */
export function contentSummary(pack: PackView): string {
  const parts = CONTENT_KIND_ORDER.map((kind) => {
    const count = pack.contents.filter((item) => item.kind === kind).length;
    if (count === 0) {
      return null;
    }
    const meta = CONTENT_KIND_META[kind];
    const label = count === 1 ? meta.label : meta.plural;
    return `${count} ${label.toLowerCase()}`;
  }).filter((part): part is string => part !== null);

  if (parts.length <= CONTENT_SUMMARY_MAX_KINDS) {
    return parts.join(" · ");
  }
  const shown = parts.slice(0, CONTENT_SUMMARY_MAX_KINDS);
  const extra = parts.length - shown.length;
  return `${shown.join(" · ")} · +${extra} more`;
}
