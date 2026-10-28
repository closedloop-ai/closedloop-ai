import { RECOMMENDED_DATA_SYNC_LEVEL } from "@repo/api/src/types/data-sync-level";

// The graduated "data sync level" (FEA-3907) — a single product control that
// supersedes four scattered desktop Labs toggles (Cloud Connection, Transcript
// Sync, Cloud Commands Paused, and the per-tool Data Collection switches). One
// selected level answers the whole question: how much of my data goes to the
// cloud? Ranked least-to-most exposure.
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

// The level the sandbox starts on: the one production recommends and the
// shared card badges "Recommended". Imported rather than copied, so the
// pre-selection cannot drift from the badge (ISS-12522).
export const DEFAULT_DATA_SYNC_LEVEL: DataSyncLevel =
  RECOMMENDED_DATA_SYNC_LEVEL;

// The levels the picker offers, most-permissive first, the order the
// production picker renders. Titles and badge labels are not kept here: the
// page reads them from DATA_SYNC_LEVEL_COPY, the same source the card prints,
// so the radio's accessible name and its visible label cannot drift apart.
//
// Redacted (DataSyncLevel.Redacted) is intentionally omitted: the redaction
// lane is not plumbed yet, so production hides the option (it behaves like
// Metadata only until redaction ships). The enum value and rank are kept so a
// persisted/migrated `redacted` selection stays valid.
export const DATA_SYNC_PICKER_LEVELS: readonly DataSyncLevel[] = [
  DataSyncLevel.Full,
  DataSyncLevel.Metadata,
  DataSyncLevel.Off,
];
