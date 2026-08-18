// The graduated "data sync level" (FEA-3907) — a single product control that
// supersedes four scattered desktop Labs toggles (Cloud Connection, Transcript
// Sync, Cloud Commands Paused, and the per-tool Data Collection switches). One
// selected level answers the whole question: how much of my data goes to the
// cloud? Ranked least-to-most exposure so the DEFAULT lands in the middle and
// the most-permissive level can carry an elevated-risk affordance.
export const DataSyncLevel = {
  Off: "off",
  Metadata: "metadata",
  Redacted: "redacted",
  Full: "full",
} as const;

export type DataSyncLevel = (typeof DataSyncLevel)[keyof typeof DataSyncLevel];

// Higher rank = more data leaves the device. Used to classify a change as an
// upgrade (opens sync lanes) or a downgrade (closes them) on apply.
export const DATA_SYNC_LEVEL_RANK: Record<DataSyncLevel, number> = {
  [DataSyncLevel.Off]: 0,
  [DataSyncLevel.Metadata]: 1,
  [DataSyncLevel.Redacted]: 2,
  [DataSyncLevel.Full]: 3,
};

// The recommended level — carries the DEFAULT chip. Metadata syncs enough to
// unlock cloud insights without ever uploading prompt or file contents.
export const DEFAULT_DATA_SYNC_LEVEL: DataSyncLevel = DataSyncLevel.Metadata;

export type DataLine = {
  label: string;
  kind: "sync" | "local";
};

export type DataSyncLevelOption = {
  level: DataSyncLevel;
  title: string;
  description: string;
  // Short label for the current-level summary badge.
  badgeLabel: string;
  // What leaves the device vs. what stays local, described inline so the choice
  // is informed.
  dataLines: readonly DataLine[];
  // The most-permissive level is elevated: it uploads full transcript bodies.
  elevated?: boolean;
  caveat?: string;
};

export const dataSyncLevelOptions: readonly DataSyncLevelOption[] = [
  {
    level: DataSyncLevel.Off,
    title: "Off",
    description:
      "No cloud connection. Nothing leaves this device; your dashboard shows only what is on this machine.",
    badgeLabel: "Off",
    dataLines: [
      { label: "Session shape, timing & cost", kind: "local" },
      { label: "Tool calls & file outputs", kind: "local" },
      { label: "Prompts & completions", kind: "local" },
    ],
    caveat: "You lose cloud insights and team sharing while this is selected.",
  },
  {
    level: DataSyncLevel.Metadata,
    title: "Metadata only",
    description:
      "Sync session shape, timing, and cost. The contents of a prompt or file never leave your machine.",
    badgeLabel: "Metadata only",
    dataLines: [
      { label: "Session shape, timing & cost", kind: "sync" },
      { label: "Tool calls & file outputs", kind: "local" },
      { label: "Prompts & completions", kind: "local" },
    ],
  },
  // Redacted (DataSyncLevel.Redacted) is intentionally omitted from the picker:
  // the redaction lane is not plumbed yet, so production hides the option (it
  // behaves like Metadata only until redaction ships). The enum value and rank
  // are kept so a persisted/migrated `redacted` selection stays valid.
  {
    level: DataSyncLevel.Full,
    title: "Full transcripts",
    description:
      "Upload complete session transcripts for the richest insights, replays, and team comparisons.",
    badgeLabel: "Full transcripts",
    elevated: true,
    dataLines: [
      { label: "Session shape, timing & cost", kind: "sync" },
      { label: "Tool calls & file outputs", kind: "sync" },
      { label: "Prompts & completions", kind: "sync" },
    ],
    caveat:
      "Complete transcript bodies leave this device, including prompt and file contents.",
  },
];

export function findDataSyncLevelOption(
  level: DataSyncLevel
): DataSyncLevelOption {
  const option = dataSyncLevelOptions.find((o) => o.level === level);
  if (!option) {
    throw new Error(`Unknown data sync level: ${level}`);
  }
  return option;
}
