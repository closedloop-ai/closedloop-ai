import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import type { DataLine } from "../components/data-line-row";

/**
 * The *presentational copy* for each data-sync level (title, benefit line,
 * per-line egress breakdown, caveat) — and only that.
 *
 * It lives in `@repo/app/shared`, not in the desktop package, because BOTH the
 * desktop Settings "Data & Sync" tab and the consent surfaces render from it, so
 * the two can never tell different stories about what leaves the machine. The
 * desktop main-process `data-sync-level.ts` keeps the boolean mapping and the
 * migration and never pulls in this presentational module.
 *
 * ISS-6147: the VALUE SET is not declared here. It used to be — a hardcoded
 * mirror of the desktop `DataSyncLevel` const kept honest by a parity test —
 * which is a duplicate with a guard rather than one definition. Both sides now
 * import `@repo/api/src/types/data-sync-level`.
 */

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
 * ⚠️ THE `metadata` AND `redacted` "Prompts & completions" LINES ARE STILL NOT
 * FULLY RECONCILED (ISS-7775). Most of the gap is closed; two channels remain.
 * Read this before citing them as verified in either direction.
 *
 *  - `off`      — cloud connection off; nothing syncs. Every line local.
 *  - `metadata` — session aggregates (shape/timing/cost) sync AND per-event rows
 *                 carrying `eventType` + `toolName` leave (the tool-call activity
 *                 the "Metadata only" analytics lane exists to surface). The
 *                 event row's tool INPUTS/outputs (`data`) and its `summary` do
 *                 not: `sanitizeSessionForSync` rebuilds each event from five
 *                 columnar fields. That is the whole of what FEA-2718 closed.
 *
 *                 The `metadata` BLOB was a second channel FEA-2718 never
 *                 touched, and it shipped turn text verbatim in
 *                 `metadata.messages[].text`, plan prose in
 *                 `metadata.plans[].content`, and anything under a key nobody
 *                 had written a policy for — `compactMetadataForPreview` was a
 *                 deny-list plus bounds, so the set was OPEN. ISS-7775 closed
 *                 that: below `full` the compactor keeps non-strings
 *                 unconditionally and drops a string unless its complete PATH is
 *                 in `STRUCTURAL_METADATA_STRING_PATHS`, so a key added later
 *                 egresses nothing by default.
 *
 *                 TWO PROMPT-CLASS CHANNELS REMAIN OPEN, both outside the blob
 *                 and both escalated rather than closed here: `agents[].name`
 *                 (the first 60 chars of a raw delegation prompt, ISS-7554,
 *                 whose wire field is required non-empty) and `session.name`
 *                 (the harness AI title, FEA-3578, written by summarizing the
 *                 conversation). Both are session/agent ROW fields, so no
 *                 metadata policy can reach them, and closing either decides
 *                 what the cloud UI shows instead of a name. Do not re-derive a
 *                 "stays local" claim from a channel audit; only running the
 *                 real producer settles what leaves, which the desktop guards
 *                 `data-sync-egress-honesty.test.ts` and
 *                 `data-sync-tier-egress.test.ts` do.
 *
 *                 THAT PAIR SETTLES THE SESSION-METADATA PAYLOAD AND NOTHING
 *                 ELSE, so do not read a green run as clearing every line here.
 *                 Their own header records what they cannot see: the
 *                 component-inventory and invocation-parts lane BODIES, which
 *                 POST `SyncedComponent.content` and
 *                 `AgentComponentInvocationSyncItem.definitionContent` —
 *                 definition FILE TEXT — on a gate this same tier opens
 *                 (ISS-7777). The "Tool inputs & file contents" line is
 *                 therefore unsettled in BOTH directions by those guards; they
 *                 deliberately refuse to certify it as local. (Session-row
 *                 FIELDS were the other stated blind spot; ISS-7775 planted
 *                 `session.name` in the probe, so that one is now observed and
 *                 is the second open channel named above.)
 *  - `redacted` — not plumbed yet; behaves exactly as `metadata` until the
 *                 redaction lane ships, so its lines mirror `metadata` —
 *                 including the two residual channels above.
 *  - `full`     — transcript lane on; complete transcript bodies (turn text, tool
 *                 inputs/outputs, file contents) are archived to the cloud.
 *
 * The `dataLines` below are DELIBERATELY LEFT UNCHANGED, and ISS-7775 moved the
 * CODE to meet them rather than amending them. The residual reconciliation is a
 * consent decision (amend the copy, or close the two channels), not an
 * implementation one.
 */
export const DATA_SYNC_LEVEL_COPY: Record<DataSyncLevel, DataSyncLevelCopy> = {
  [DataSyncLevel.Off]: {
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
  [DataSyncLevel.Metadata]: {
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
  [DataSyncLevel.Redacted]: {
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
      "Redaction is coming soon. Until it ships, this behaves exactly like Metadata only, and no session content leaves this device.",
  },
  [DataSyncLevel.Full]: {
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
      "Transcripts, prompts, and file contents sync to the cloud for complete analysis.",
  },
};

/** Look up the canonical copy for a level, throwing on an unknown value. */
export function findDataSyncLevelCopy(level: DataSyncLevel): DataSyncLevelCopy {
  const copy = DATA_SYNC_LEVEL_COPY[level];
  if (!copy) {
    throw new Error(`Unknown data sync level: ${level}`);
  }
  return copy;
}
