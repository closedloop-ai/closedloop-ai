/**
 * @file transcript-walk-skip-ledger.ts
 * @description ISS-8506 — turn the directories a harness walk could not
 * enumerate into inventory impairments.
 *
 * The root probe answers "could we open this harness at all". It cannot answer
 * "did the walk get all the way down", because the enumerators swallow a nested
 * `EACCES` and return a shortened listing that looks exactly like a small
 * corpus. A readable Claude home with one denied project directory would
 * therefore read as `complete` and understate the total — the confident-but-
 * short number this ticket exists to prevent.
 *
 * This module only maps collector vocabulary ({@link DirectoryWalkSkipReason})
 * onto inventory vocabulary ({@link TranscriptImpairmentReason}), the same shape
 * `transcript-harness-probe.ts` uses for root verdicts.
 */
import {
  DirectoryWalkSkipReason,
  type DirectoryWalkSkipSink,
} from "../collectors/engine/directory-walk-skip.js";
import {
  type TranscriptByteLane,
  TranscriptImpairmentReason,
  type TranscriptInventoryImpairment,
} from "./transcript-byte-inventory-types.js";
import type { TranscriptSourceHarness } from "./transcript-sync-types.js";

/** Collects walk skips across every harness listing in one sweep. */
export type TranscriptWalkSkipLedger = {
  /**
   * The sink to hand the listers for one harness. `lane` scopes every skip the
   * sink records to that lane; omit it for a listing both lanes read.
   */
  sinkFor: (
    harness: TranscriptSourceHarness,
    lane?: TranscriptByteLane
  ) => DirectoryWalkSkipSink;
  /**
   * One impairment per (harness, reason, lane), counting DISTINCT directories.
   * Each harness gets ONE sink per lane it is walked on — a second sink for the
   * same harness under another lane would report a shared directory twice.
   */
  impairments: () => TranscriptInventoryImpairment[];
};

const IMPAIRMENT_FOR_SKIP: Readonly<
  Record<DirectoryWalkSkipReason, TranscriptImpairmentReason>
> = {
  [DirectoryWalkSkipReason.ReadError]:
    TranscriptImpairmentReason.SubtreeUnreadable,
  [DirectoryWalkSkipReason.MaxDepth]:
    TranscriptImpairmentReason.SubtreeDepthTruncated,
};

/**
 * A fresh ledger for one sweep.
 *
 * Directories are deduped per (harness, reason) because the Claude listers walk
 * the same `projects/` tree twice — once for session transcripts, once for
 * subagent sidecars — so one denied project directory is one gap, not two. The
 * count is of DIRECTORIES, never of the files inside them: those were never
 * enumerated, so their number is unknowable and inventing one would be the very
 * fabrication this measurement refuses.
 */
export function createTranscriptWalkSkipLedger(): TranscriptWalkSkipLedger {
  const dirsByKey = new Map<
    string,
    {
      harness: TranscriptSourceHarness;
      reason: TranscriptImpairmentReason;
      lane?: TranscriptByteLane;
      dirs: Set<string>;
    }
  >();
  return {
    sinkFor: (harness, lane) => (dir, reason) => {
      const impairment = IMPAIRMENT_FOR_SKIP[reason];
      const key = `${harness} ${impairment} ${lane ?? ""}`;
      const entry = dirsByKey.get(key) ?? {
        harness,
        reason: impairment,
        dirs: new Set<string>(),
        ...(lane ? { lane } : {}),
      };
      entry.dirs.add(dir);
      dirsByKey.set(key, entry);
    },
    impairments: () =>
      [...dirsByKey.values()].map((entry) => ({
        reason: entry.reason,
        harness: entry.harness,
        count: entry.dirs.size,
        ...(entry.lane ? { lane: entry.lane } : {}),
      })),
  };
}
