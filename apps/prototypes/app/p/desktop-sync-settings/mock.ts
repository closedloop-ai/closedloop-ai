// Sync-observability tier, kept in exact parity with the desktop
// `SyncObservabilityTier` contract: `"full" | "metadata" | "local"`. The
// durable Settings control persists via `desktop:set-sync-observability-tier`;
// the initial value can be `null` when a user has never chosen a level.
export const SyncTier = {
  Full: "full",
  Metadata: "metadata",
  Local: "local",
} as const;

export type SyncTier = (typeof SyncTier)[keyof typeof SyncTier];

// Higher rank = more data leaves the device. Used to classify a change as an
// upgrade (opens more sync lanes) or a downgrade (closes lanes).
export const SYNC_TIER_RANK: Record<SyncTier, number> = {
  [SyncTier.Local]: 0,
  [SyncTier.Metadata]: 1,
  [SyncTier.Full]: 2,
};

export type SyncDataLine = {
  label: string;
  kind: "sync" | "local";
};

export type SyncTierOption = {
  tier: SyncTier;
  title: string;
  description: string;
  // Short label for the current-tier summary badge.
  badgeLabel: string;
  // What leaves the device vs. what stays local, described inline so the
  // choice is informed (acceptance criterion).
  dataLines: readonly SyncDataLine[];
  caveat?: string;
};

export const syncTierOptions: readonly SyncTierOption[] = [
  {
    tier: SyncTier.Full,
    title: "Full session sync",
    description:
      "Get the richest insights, replays, and team comparisons on any machine you log into.",
    badgeLabel: "Full sync",
    dataLines: [
      { label: "Session shape, timing & cost", kind: "sync" },
      { label: "Tool calls & file outputs", kind: "sync" },
      { label: "Prompts & completions", kind: "sync" },
    ],
  },
  {
    tier: SyncTier.Metadata,
    title: "Metadata only",
    description:
      "Sync session shape, timing, and cost, but the contents of a prompt or file stay on your machine.",
    badgeLabel: "Metadata only",
    dataLines: [
      { label: "Session shape, timing & cost", kind: "sync" },
      { label: "Tool calls & file outputs", kind: "local" },
      { label: "Prompts & completions", kind: "local" },
    ],
  },
  {
    tier: SyncTier.Local,
    title: "Keep local",
    description:
      "Nothing leaves this device. Your local dashboard only surfaces what you have on this machine.",
    badgeLabel: "Local only",
    dataLines: [
      { label: "Session shape, timing & cost", kind: "local" },
      { label: "Tool calls & file outputs", kind: "local" },
      { label: "Prompts & completions", kind: "local" },
    ],
    caveat: "You lose cloud insights and team sharing while this is selected.",
  },
];

export function findSyncTierOption(tier: SyncTier): SyncTierOption {
  const option = syncTierOptions.find((o) => o.tier === tier);
  if (!option) {
    throw new Error(`Unknown sync tier: ${tier}`);
  }
  return option;
}
