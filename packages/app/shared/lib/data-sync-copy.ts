import type { DataLine } from "../components/data-line-row";

/**
 * The canonical "data sync level" value set (FEA-3907 / FEA-4055). ONE value
 * answers "how much of my data goes to the cloud?" and the desktop settings
 * store deterministically derives every connectivity/sync boolean from it (see
 * `apps/desktop/src/shared/data-sync-level.ts` — `dataSyncLevelToBooleans`).
 *
 * This module is the SINGLE SOURCE OF TRUTH for the *presentational copy* of
 * each level (title, benefit line, per-line egress breakdown, caveat). It lives
 * in `@repo/app/shared` — not in the desktop package — because BOTH the desktop
 * Settings "Data & Sync" tab (`apps/desktop/src/renderer/components/settings/
 * data-sync-tab.tsx`) AND the onboarding sync-consent step
 * (`packages/app/onboarding/components/sync-consent.tsx`) render from it, so the
 * two surfaces can never drift into telling two different stories about what
 * leaves the machine. The desktop main-process `data-sync-level.ts` keeps the
 * value logic (ranking, boolean mapping, migration) but no longer owns the copy,
 * so the main-process bundle never pulls in this presentational module.
 *
 * The value strings are a hardcoded mirror of the desktop `DataSyncLevel` const
 * (`apps/desktop/src/shared/contracts.ts`). `@repo/app` cannot import from
 * `apps/desktop` (that would invert the app→package dependency direction), so
 * the two are kept in exact parity and the desktop Settings tab keying its
 * `DataSyncLevel` into {@link DATA_SYNC_LEVEL_COPY} is the compile-time guard: a
 * divergence in either literal set stops that call site type-checking.
 */
export const DataSyncLevelValue = {
  Off: "off",
  Metadata: "metadata",
  Redacted: "redacted",
  Full: "full",
} as const;
export type DataSyncLevelValue =
  (typeof DataSyncLevelValue)[keyof typeof DataSyncLevelValue];

/** The per-level presentational copy rendered identically on both surfaces. */
export type DataSyncLevelCopy = {
  title: string;
  /** Benefit-only one-liner; the `dataLines` carry what actually leaves. */
  description: string;
  /** Short label for the current-level summary badge. */
  badgeLabel: string;
  dataLines: readonly DataLine[];
  caveat?: string;
};

/**
 * Copy per canonical level, in ranked least-to-most exposure order.
 *
 * The per-line egress is TRUE against the verified desktop wire payload:
 *  - `off`      — cloud connection off; nothing syncs. Every line local.
 *  - `metadata` — session aggregates (shape/timing/cost) sync AND per-event rows
 *                 carrying `eventType` + `toolName` leave (the tool-call activity
 *                 the "Metadata only" analytics lane exists to surface), but the
 *                 tool INPUTS/outputs (`data`) and file contents do NOT, and turn
 *                 text was dropped from the cloud lane in FEA-2718 (the API sync
 *                 Zod strips `summary`/`data`), so prompts & completions genuinely
 *                 stay on the device. The tool-call line is therefore split so the
 *                 synced dimension (activity: names & counts) is not conflated with
 *                 the local dimension (inputs & file contents).
 *  - `redacted` — not plumbed yet; behaves exactly as `metadata` until the
 *                 redaction lane ships, so its lines mirror `metadata`.
 *  - `full`     — transcript lane on; complete transcript bodies (turn text, tool
 *                 inputs/outputs, file contents) are archived to the cloud.
 */
export const DATA_SYNC_LEVEL_COPY: Record<
  DataSyncLevelValue,
  DataSyncLevelCopy
> = {
  [DataSyncLevelValue.Off]: {
    title: "Off",
    description: "Nothing leaves this device.",
    badgeLabel: "Off",
    dataLines: [
      { label: "Session shape, timing & cost", kind: "local" },
      { label: "Tool-call activity (names & counts)", kind: "local" },
      { label: "Tool inputs & file contents", kind: "local" },
      { label: "Prompts & completions", kind: "local" },
    ],
    caveat:
      "You won't be able to sync across machines or compare with your team.",
  },
  [DataSyncLevelValue.Metadata]: {
    title: "Metadata only",
    description: "Cloud insights without your prompts or files.",
    badgeLabel: "Metadata only",
    dataLines: [
      { label: "Session shape, timing & cost", kind: "sync" },
      { label: "Tool-call activity (names & counts)", kind: "sync" },
      { label: "Tool inputs & file contents", kind: "local" },
      { label: "Prompts & completions", kind: "local" },
    ],
  },
  [DataSyncLevelValue.Redacted]: {
    title: "Redacted sessions",
    description: "Cloud insights without your prompts or files.",
    badgeLabel: "Redacted",
    // The redaction lane is not plumbed yet, so these lines must reflect the
    // ACTUAL current behavior — metadata-only, no session content leaves — not
    // the eventual redacted-content behavior.
    dataLines: [
      { label: "Session shape, timing & cost", kind: "sync" },
      { label: "Tool-call activity (names & counts)", kind: "sync" },
      { label: "Tool inputs & file contents", kind: "local" },
      { label: "Prompts & completions", kind: "local" },
    ],
    caveat:
      "Redaction is coming soon. Until it ships, this behaves exactly like Metadata only — no session content leaves this device.",
  },
  [DataSyncLevelValue.Full]: {
    title: "Full transcripts",
    description: "The richest insights, replays, and team comparisons.",
    badgeLabel: "Full transcripts",
    dataLines: [
      { label: "Session shape, timing & cost", kind: "sync" },
      { label: "Tool-call activity (names & counts)", kind: "sync" },
      { label: "Tool inputs & file contents", kind: "sync" },
      { label: "Prompts & completions", kind: "sync" },
    ],
    caveat:
      "Transcripts, prompts, and file contents are sync'd for complete analysis.",
  },
};

/** The level a fresh install / onboarding starts on (safest insight-bearing). */
export const DEFAULT_DATA_SYNC_LEVEL_VALUE: DataSyncLevelValue =
  DataSyncLevelValue.Metadata;

/** The most-permissive level — the one `dataSyncLevelBadge` marks "Recommended". */
export const ELEVATED_DATA_SYNC_LEVEL_VALUE: DataSyncLevelValue =
  DataSyncLevelValue.Full;

/** Look up the canonical copy for a level, throwing on an unknown value. */
export function findDataSyncLevelCopy(
  level: DataSyncLevelValue
): DataSyncLevelCopy {
  const copy = DATA_SYNC_LEVEL_COPY[level];
  if (!copy) {
    throw new Error(`Unknown data sync level: ${level}`);
  }
  return copy;
}
