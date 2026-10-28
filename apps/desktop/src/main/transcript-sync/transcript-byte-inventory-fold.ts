/**
 * @file transcript-byte-inventory-fold.ts
 * @description ISS-8506 - the per-entry fold behind `buildTranscriptByteInventory`:
 * classify one stat'ed path, then credit it to the lane(s) that read it.
 *
 * Split from `transcript-byte-inventory.ts` so that module keeps the sweep
 * (probes, listers, cap, completeness) and this one keeps the arithmetic. The
 * reconciliation identity `discoveredBytes === eligibleParseBytes +
 * excludedBytes` lives here, enforced by construction: every parse-lane byte
 * flows through one `creditBytes` call that credits exactly one bucket and adds
 * to discovered in the same statement.
 */
import {
  type ExclusionTally,
  TRANSCRIPT_EXCLUSION_REASONS,
  TranscriptByteLane,
  type TranscriptEligibleFile,
  TranscriptExclusionReason,
  type TranscriptHarnessSessionCount,
  TranscriptImpairmentReason,
  type TranscriptInventoryImpairment,
} from "./transcript-byte-inventory-types.js";
import {
  type TranscriptFileRef,
  TranscriptSourceHarness,
  transcriptQueueKey,
} from "./transcript-sync-types.js";

/** The `lstat` fields this measurement needs. */
export type TranscriptEntryStat = {
  size: number;
  mtimeMs: number;
  isSymbolicLink: boolean;
  isFile: boolean;
  dev: number;
  ino: number;
};

/** Injectable seams for {@link buildTranscriptByteInventory}. */
export type TranscriptInventoryDeps = {
  /** Returns `undefined` when the entry could not be stat'ed at all. */
  lstatEntry: (sourcePath: string) => TranscriptEntryStat | undefined;
  nextRevision: () => number;
};

/**
 * A file only the PARSE lane reads, so it has no archive-row identity.
 *
 * Today that is OpenCode's `opencode.db` and its WAL/SHM siblings: what the
 * collector parses, and never what the archive lane sends.
 */
export type TranscriptRawStoreFile = {
  harness: TranscriptSourceHarness;
  sourcePath: string;
};

/** A zeroed tally for every reason, so a missing key can never read as absent. */
function emptyExclusionTallies(): Record<
  TranscriptExclusionReason,
  ExclusionTally
> {
  const tallies = Object.create(null) as Record<
    TranscriptExclusionReason,
    ExclusionTally
  >;
  for (const reason of TRANSCRIPT_EXCLUSION_REASONS) {
    tallies[reason] = { files: 0, bytes: 0 };
  }
  return tallies;
}

/** The exclusion reason for one stat'ed entry, or `undefined` when eligible. */
function classifyEntry(
  stat: TranscriptEntryStat,
  scanStart: number
): TranscriptExclusionReason | undefined {
  if (stat.isSymbolicLink) {
    return TranscriptExclusionReason.Symlink;
  }
  if (!stat.isFile) {
    return TranscriptExclusionReason.NotRegularFile;
  }
  if (stat.mtimeMs >= scanStart) {
    return TranscriptExclusionReason.Unstable;
  }
  if (stat.size === 0) {
    return TranscriptExclusionReason.Empty;
  }
  return undefined;
}

/**
 * Whether a filesystem-reported size can be a byte count at all.
 *
 * One predicate over the WHOLE impossible set, not the two that get remembered.
 * `Number.isSafeInteger` rejects `NaN`, both infinities, any fractional value,
 * and any magnitude past 2^53 in a single check; the explicit `>= 0` adds the
 * negative case, which safe-integer alone admits. Each of those renders as a
 * confident measurement downstream, which is worse than a refusal.
 */
export function isMeasurableByteSize(size: number): boolean {
  return Number.isSafeInteger(size) && size >= 0;
}

/** Which lanes read one entry. */
type LaneMembership = { parse: boolean; upload: boolean };

/** One path to measure, with the lanes it credits and its archive-row identity. */
type MeasuredEntry = {
  sourcePath: string;
  harness: TranscriptSourceHarness;
  lanes: LaneMembership;
  /** The lane a file-level impairment on this entry is scoped to; omitted = both. */
  lane?: TranscriptByteLane;
  /** Absent for a raw store, which is never an archive row. */
  archive?: { externalSessionId: string; fileKey: string };
};

/**
 * Refs and raw stores as one entry stream.
 *
 * OpenCode is the only harness whose two sources differ, so its refs are the
 * only single-lane refs. Everything else credits both lanes from one file.
 */
export function measuredEntries(
  refs: readonly TranscriptFileRef[],
  rawStores: readonly TranscriptRawStoreFile[]
): MeasuredEntry[] {
  const fromRefs = refs.map((ref): MeasuredEntry => {
    const uploadOnly = ref.sourceHarness === TranscriptSourceHarness.OpenCode;
    return {
      sourcePath: ref.sourcePath,
      harness: ref.sourceHarness,
      lanes: { parse: !uploadOnly, upload: true },
      ...(uploadOnly ? { lane: TranscriptByteLane.Upload } : {}),
      archive: {
        externalSessionId: ref.externalSessionId,
        fileKey: ref.fileKey,
      },
    };
  });
  const fromStores = rawStores.map(
    (store): MeasuredEntry => ({
      sourcePath: store.sourcePath,
      harness: store.harness,
      lanes: { parse: true, upload: false },
      lane: TranscriptByteLane.Parse,
    })
  );
  return [...fromRefs, ...fromStores];
}

/** Everything the per-entry fold produces, read once after the last entry. */
type MeasuredTotals = {
  discoveredBytes: number;
  eligibleParseBytes: number;
  excludedBytes: number;
  exclusionsByReason: Record<TranscriptExclusionReason, ExclusionTally>;
  physicalBytes: number;
  attributableRawBytes: number;
  eligibleFiles: TranscriptEligibleFile[];
  uploadExclusionsByReason: Record<TranscriptExclusionReason, ExclusionTally>;
  fileImpairments: TranscriptInventoryImpairment[];
  /** The harness being credited when a lane's sum left the exact range. */
  precisionLostAt: Partial<Record<TranscriptByteLane, TranscriptSourceHarness>>;
};

/**
 * The per-lane accumulators behind {@link buildTranscriptByteInventory}.
 *
 * Every parse-lane byte flows through one `creditBytes` call that credits
 * exactly one of eligible/excluded and adds to discovered in the same
 * statement, which is what makes the reconciliation identity hold by
 * construction. The upload lane keeps the archive-row map plus its own running
 * total and exclusion tally, guarded the same way, so neither lane can render
 * a sum it did not compute exactly.
 */
export function createInventoryAccumulator() {
  const exclusionsByReason = emptyExclusionTallies();
  const uploadExclusionsByReason = emptyExclusionTallies();
  const totals = { discovered: 0, eligible: 0, excluded: 0, upload: 0 };
  const precisionLostAt: Partial<
    Record<TranscriptByteLane, TranscriptSourceHarness>
  > = {};
  const creditBytes = (
    bytes: number,
    harness: TranscriptSourceHarness,
    reason?: TranscriptExclusionReason
  ) => {
    // Checked BEFORE the write, because after it the damage is already in the
    // total and no later inspection can tell an exact sum from a rounded one.
    if (!Number.isSafeInteger(totals.discovered + bytes)) {
      precisionLostAt[TranscriptByteLane.Parse] ??= harness;
      return;
    }
    totals.discovered += bytes;
    if (reason) {
      totals.excluded += bytes;
      const tally = exclusionsByReason[reason];
      tally.files += 1;
      tally.bytes += bytes;
      return;
    }
    totals.eligible += bytes;
  };

  const seenInodes = new Set<string>();
  const eligibleByArchiveKey = new Map<string, TranscriptEligibleFile>();
  const fileImpairments = createFileImpairmentTally();
  let physicalBytes = 0;

  const creditPhysical = (stat: TranscriptEntryStat) => {
    // A disk view, not a lane view: a projection is real bytes on disk beside
    // its store, and `(dev, ino)` dedup is what keeps a hardlink at one count.
    const inodeKey = `${stat.dev}:${stat.ino}`;
    if (!seenInodes.has(inodeKey)) {
      seenInodes.add(inodeKey);
      physicalBytes += stat.size;
    }
  };

  const creditUploadRow = (entry: MeasuredEntry, stat: TranscriptEntryStat) => {
    if (!entry.archive) {
      return;
    }
    const rowKey = transcriptQueueKey(
      entry.archive.externalSessionId,
      entry.archive.fileKey
    );
    if (eligibleByArchiveKey.has(rowKey)) {
      return;
    }
    if (!Number.isSafeInteger(totals.upload + stat.size)) {
      precisionLostAt[TranscriptByteLane.Upload] ??= entry.harness;
      return;
    }
    totals.upload += stat.size;
    eligibleByArchiveKey.set(rowKey, {
      externalSessionId: entry.archive.externalSessionId,
      fileKey: entry.archive.fileKey,
      bytes: stat.size,
    });
  };

  return {
    absorb(entry: MeasuredEntry, verdict: EntryVerdict) {
      if (verdict.impairment) {
        fileImpairments.tally(verdict.impairment, entry.harness, entry.lane);
      }
      if (!entry.archive && isIndirectExclusion(verdict.exclusion)) {
        // A store, not a transcript: its bytes will be parsed through the link
        // whatever `lstat` says, so the exclusion alone would leave a
        // confident zero. See `TranscriptImpairmentReason.RawStoreIndirect`.
        fileImpairments.tally(
          TranscriptImpairmentReason.RawStoreIndirect,
          entry.harness,
          entry.lane
        );
      }
      if (entry.lanes.parse) {
        creditBytes(verdict.bytes, entry.harness, verdict.exclusion);
      }
      if (entry.lanes.upload && verdict.exclusion) {
        const tally = uploadExclusionsByReason[verdict.exclusion];
        tally.files += 1;
        tally.bytes += verdict.bytes;
      }
      if (verdict.exclusion || !verdict.stat) {
        return;
      }
      creditPhysical(verdict.stat);
      if (entry.lanes.upload) {
        creditUploadRow(entry, verdict.stat);
      }
    },
    result(): MeasuredTotals {
      return {
        discoveredBytes: totals.discovered,
        eligibleParseBytes: totals.eligible,
        excludedBytes: totals.excluded,
        exclusionsByReason,
        physicalBytes,
        attributableRawBytes: totals.upload,
        eligibleFiles: [...eligibleByArchiveKey.values()],
        uploadExclusionsByReason,
        fileImpairments: fileImpairments.list(),
        precisionLostAt,
      };
    },
  };
}

/** What one stat'ed path contributes, and what it admits it could not. */
type EntryVerdict = {
  /** Bytes credited to the parse partition: the real size, or 0 when unknowable. */
  bytes: number;
  exclusion?: TranscriptExclusionReason;
  impairment?: FileImpairmentReason;
  stat?: TranscriptEntryStat;
};

type FileImpairmentReason =
  | typeof TranscriptImpairmentReason.FileUnreadable
  | typeof TranscriptImpairmentReason.FileUnstable
  | typeof TranscriptImpairmentReason.FileSizeImplausible
  | typeof TranscriptImpairmentReason.RawStoreIndirect;

const FILE_IMPAIRMENT_REASONS: readonly FileImpairmentReason[] = [
  TranscriptImpairmentReason.FileUnreadable,
  TranscriptImpairmentReason.FileUnstable,
  TranscriptImpairmentReason.FileSizeImplausible,
  TranscriptImpairmentReason.RawStoreIndirect,
];

/** An exclusion that hides a file SQLite would still open through the link. */
function isIndirectExclusion(
  exclusion: TranscriptExclusionReason | undefined
): boolean {
  return (
    exclusion === TranscriptExclusionReason.Symlink ||
    exclusion === TranscriptExclusionReason.NotRegularFile
  );
}

export function classifyEntryPath(
  sourcePath: string,
  deps: TranscriptInventoryDeps,
  scanStart: number
): EntryVerdict {
  const stat = deps.lstatEntry(sourcePath);
  if (!stat) {
    // Size unknowable, so it credits zero bytes - but it still impairs, which
    // is what stops a locked corpus reading as a confident total.
    return {
      bytes: 0,
      exclusion: TranscriptExclusionReason.Unreadable,
      impairment: TranscriptImpairmentReason.FileUnreadable,
    };
  }
  if (!isMeasurableByteSize(stat.size)) {
    // Same shape as an unreadable file, for the same reason: the file exists
    // but its real byte count is unknown, so crediting the reported number
    // would put a value we know is false inside a total.
    return {
      bytes: 0,
      exclusion: TranscriptExclusionReason.ImplausibleSize,
      impairment: TranscriptImpairmentReason.FileSizeImplausible,
      stat,
    };
  }
  const exclusion = classifyEntry(stat, scanStart);
  if (exclusion === TranscriptExclusionReason.Unstable) {
    return {
      bytes: stat.size,
      exclusion,
      impairment: TranscriptImpairmentReason.FileUnstable,
      stat,
    };
  }
  return exclusion
    ? { bytes: stat.size, exclusion, stat }
    : { bytes: stat.size, stat };
}

/**
 * Per-(reason, harness, lane) counts of file-level impairments, emitted in a
 * fixed reason order so the impairment list is stable across runs. `lane` is
 * OMITTED from an emitted impairment when it shortens both lanes.
 */
function createFileImpairmentTally() {
  const counts = new Map<
    string,
    {
      reason: FileImpairmentReason;
      harness: TranscriptSourceHarness;
      lane?: TranscriptByteLane;
      count: number;
    }
  >();
  return {
    tally(
      reason: FileImpairmentReason,
      harness: TranscriptSourceHarness,
      lane: TranscriptByteLane | undefined
    ) {
      const key = `${reason}|${harness}|${lane ?? ""}`;
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
        return;
      }
      counts.set(key, { reason, harness, count: 1, ...(lane ? { lane } : {}) });
    },
    list(): TranscriptInventoryImpairment[] {
      const out: TranscriptInventoryImpairment[] = [];
      for (const reason of FILE_IMPAIRMENT_REASONS) {
        for (const entry of counts.values()) {
          if (entry.reason !== reason) {
            continue;
          }
          out.push({
            reason: entry.reason,
            harness: entry.harness,
            count: entry.count,
            ...(entry.lane ? { lane: entry.lane } : {}),
          });
        }
      }
      return out;
    },
  };
}

/**
 * Whether a harness's transcript refs ARE a faithful enumeration of its
 * sessions (ISS-8346).
 *
 * An exhaustive `Record` and not a `Set<string>` or an array on purpose: a
 * side inventory of the members that qualify still compiles when a harness is
 * added, so the new one silently falls through to "not counted" and nobody is
 * asked. This shape cannot be written without naming every member.
 *
 * `claude` and `codex` qualify because every one of their sessions is
 * enumerated and every ref carries the session it belongs to — a Codex
 * descendant rollout is walked to its ROOT session id, so a subagent chain
 * collapses onto its parent rather than inflating the count.
 *
 * `opencode` does NOT. Its parse-lane source is `opencode.db`, one file holding
 * many sessions with no per-session ref, and its ref source is the MATERIALIZED
 * projection the sync sweeper writes only after consent — which is exactly what
 * onboarding runs before. A `0` there would be a fabricated zero on a machine
 * full of OpenCode sessions, and a non-zero one would be a floor of unknown
 * depth presented as a total. Not reporting is the only honest answer this
 * producer can give for it.
 */
const SESSION_ENUMERATION_IS_FAITHFUL: Record<
  TranscriptSourceHarness,
  boolean
> = {
  claude: true,
  codex: true,
  opencode: false,
};

/**
 * Distinct sessions per harness, over the refs the sweep already computed.
 *
 * Pure and exported so the count can be tested without a filesystem, the same
 * split {@link measuredEntries} has. A harness with no distinct session yields
 * NO ENTRY rather than a zero one, because "we enumerated it and found none" and
 * "we cannot enumerate it" are different claims and only the caller's evidence
 * can tell them apart.
 */
export function countDiscoveredSessions(
  refs: readonly TranscriptFileRef[]
): TranscriptHarnessSessionCount[] {
  const byHarness = new Map<TranscriptSourceHarness, Set<string>>();
  for (const ref of refs) {
    if (!SESSION_ENUMERATION_IS_FAITHFUL[ref.sourceHarness]) {
      continue;
    }
    const sessions = byHarness.get(ref.sourceHarness) ?? new Set<string>();
    sessions.add(ref.externalSessionId);
    byHarness.set(ref.sourceHarness, sessions);
  }
  return [...byHarness.entries()].map(([harness, sessions]) => ({
    harness,
    sessionCount: sessions.size,
  }));
}
