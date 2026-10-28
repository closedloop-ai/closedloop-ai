/**
 * @file transcript-byte-inventory-types.ts
 * @description ISS-8506 — the vocabulary for a canonical byte-volume
 * measurement of the local transcript corpus.
 *
 * The measurement exists so onboarding can say "N of M" about a real corpus
 * instead of a placeholder. Everything here is shaped around one rule from the
 * ticket: **never emit a fabricated total.** A measurement that could not see
 * everything says so, and a consumer that cannot show a caveat gets `unknown`
 * rather than a short number dressed up as a complete one.
 */
import type { TranscriptSourceHarness } from "./transcript-sync-types.js";

/**
 * The two consumers of a measurement, which read DIFFERENT files for OpenCode.
 *
 * Claude and Codex transcripts are parsed and uploaded from the same JSONL, so
 * one file serves both lanes. OpenCode is parsed from its raw SQLite store
 * (`opencode.db` and its WAL/SHM siblings — what `opencode-collector.ts` reads)
 * but uploaded from the JSONL projection the materializer writes under the
 * state dir. The store is on disk from the moment OpenCode is installed; the
 * projection exists only after the sync sweeper has run behind its consent
 * gate. An impairment that names a lane shortens only that lane's numbers.
 */
export const TranscriptByteLane = {
  /** `discoveredBytes` / `eligibleParseBytes` — what the collectors will read. */
  Parse: "parse",
  /** `attributableRawBytes` / `eligibleFiles` — what the archive lane would send. */
  Upload: "upload",
} as const;
export type TranscriptByteLane =
  (typeof TranscriptByteLane)[keyof typeof TranscriptByteLane];

/** How much of the corpus this measurement was actually able to see. */
export const TranscriptInventoryCompleteness = {
  /** Every enumerated harness was measured; no impairment. Safe to state as a total. */
  Complete: "complete",
  /** Something was measured, something was not. A total would understate. */
  Partial: "partial",
  /** Nothing was measured and something blocked us. We know nothing about this machine. */
  Unavailable: "unavailable",
} as const;
export type TranscriptInventoryCompleteness =
  (typeof TranscriptInventoryCompleteness)[keyof typeof TranscriptInventoryCompleteness];

/**
 * Why a file a lane reads contributed nothing to that lane.
 *
 * On the parse lane these partition the discovered set together with the
 * eligible set: `discoveredBytes === eligibleParseBytes + excludedBytes`, over
 * distinct paths, always. On the upload lane they are the files that were
 * seen and kept out of `eligibleFiles` (`uploadExclusionsByReason`), so an
 * excluded projection leaves a trace rather than vanishing from a total that
 * still calls itself complete.
 *
 * A Codex rollout whose parent chain the input cap cut is deliberately NOT one
 * of these. It never becomes a ref at all — `codexRefsFromRolloutsAttributable`
 * drops it rather than re-root it onto a session that does not exist — so it is
 * never "discovered" and cannot be excluded from a set it never entered. It is
 * reported as {@link TranscriptImpairmentReason.CodexLinkageTruncated}, which
 * is what forces the inventory to `partial`.
 */
export const TranscriptExclusionReason = {
  /** `lstat` threw. Its size is unknowable, so it contributes 0 bytes — and it impairs. */
  Unreadable: "unreadable",
  /** A symlink. The ticket's exclusion rules name these explicitly. */
  Symlink: "symlink",
  /** A directory, fifo, socket or device where a transcript file was expected. */
  NotRegularFile: "not-regular-file",
  /** Written at or after `scanStart`, so any size we read is already out of date. */
  Unstable: "unstable",
  /** A real, readable, zero-byte file. Not an error — just nothing to parse. */
  Empty: "empty",
  /**
   * The filesystem reported a size that cannot be a byte count.
   *
   * Negative and non-finite are the two everyone remembers; what actually
   * reaches a total is the rest — a fractional size, or a magnitude past
   * `Number.MAX_SAFE_INTEGER`, where every later addition silently loses
   * precision and the sum still renders as a confident number of GB. The file
   * was seen, so it is an exclusion, but its real size is unknown, so it credits
   * zero bytes and impairs exactly like an unreadable one.
   */
  ImplausibleSize: "implausible-size",
} as const;
export type TranscriptExclusionReason =
  (typeof TranscriptExclusionReason)[keyof typeof TranscriptExclusionReason];

/** Every exclusion reason, for building an exhaustive tally. */
export const TRANSCRIPT_EXCLUSION_REASONS: readonly TranscriptExclusionReason[] =
  Object.values(TranscriptExclusionReason);

/**
 * Why the measurement is short of the truth.
 *
 * An impairment is NOT the same thing as an exclusion. An excluded file was
 * seen and judged (an empty file is excluded and the measurement is still
 * complete); an impairment means something was never seen at all.
 */
export const TranscriptImpairmentReason = {
  /** EACCES/EPERM/TCC on a harness root. */
  RootBlocked: "root-blocked",
  /** An odd or transient IO error on a harness root. Conservative: treated as short. */
  RootUnknown: "root-unknown",
  /**
   * OpenCode is installed but its JSONL projection has never been written.
   *
   * An UPLOAD-lane impairment only. The projection is what the archive lane
   * sends, and only the sync sweeper writes it (`transcript-discovery-sweep.ts`,
   * behind the FEA-3463 tier gate), so before consent its size is unknowable.
   * The PARSE lane is untouched: the collector reads `opencode.db` directly, and
   * that store is measured whether or not a projection exists.
   */
  OpencodeUnmaterialized: "opencode-unmaterialized",
  /** A harness listing exceeded the input cap and was truncated to its prefix. */
  InputCapTruncated: "input-cap-truncated",
  /** One or more files could not be `lstat`ed. */
  FileUnreadable: "file-unreadable",
  /**
   * One or more files were being written while the sweep ran.
   *
   * The AC names `unstable` alongside `unreadable`, and for the same reason: an
   * unstable file is excluded from `eligibleParseBytes` but WILL be parsed once
   * it settles, so a total that omits it and calls itself complete hands the
   * parse lane a denominator it will overrun.
   */
  FileUnstable: "file-unstable",
  /** One or more files reported a size that cannot be a byte count. */
  FileSizeImplausible: "file-size-implausible",
  /**
   * A raw store (OpenCode's `opencode.db` or a sibling) is a symlink or a
   * non-regular file.
   *
   * The ticket's exclusion rules keep a symlink out of every total, and that
   * holds here — but the store is the harness's ENTIRE parse-lane input, and
   * the collector opens it through SQLite, which follows the link, so those
   * bytes WILL be parsed. A total that omits them and calls itself complete is
   * a confident "we found 0 bytes" on a machine with a real store. Same logic
   * as {@link FileUnstable}: what will be read but was not sized impairs.
   */
  RawStoreIndirect: "raw-store-indirect",
  /**
   * A lane's running total passed the exact-integer range while summing.
   *
   * Every individual size is validated first, so reaching this means that
   * lane's set is past 2^53 bytes. Beyond it addition stops being exact, and
   * the number would still render as a plausible figure — which is the one
   * thing this measurement may never do. Scoped to the lane whose sum it is.
   */
  TotalExceedsPrecision: "total-exceeds-precision",
  /**
   * A directory BELOW a readable harness root could not be read.
   *
   * Distinct from {@link RootBlocked}: the root probe saw the root fine, so
   * without this a denied project or session directory yields a short listing
   * the sweep would publish as a complete total. `count` is the number of
   * distinct directories, not of the files behind them — those were never seen,
   * so their number is unknowable and is not guessed at.
   */
  SubtreeUnreadable: "subtree-unreadable",
  /** A recursive walk hit its depth bound and did not enumerate below it. */
  SubtreeDepthTruncated: "subtree-depth-truncated",
  /** One or more Codex rollouts lost their parent chain to the cap. */
  CodexLinkageTruncated: "codex-linkage-truncated",
} as const;
export type TranscriptImpairmentReason =
  (typeof TranscriptImpairmentReason)[keyof typeof TranscriptImpairmentReason];

/**
 * One reason this measurement is short, with enough detail to act on.
 *
 * Optional fields are OMITTED when absent rather than serialized as `null`, so
 * a version-skewed consumer reading this over a wire sees absence.
 */
export type TranscriptInventoryImpairment = {
  reason: TranscriptImpairmentReason;
  harness: TranscriptSourceHarness;
  /** Home-abbreviated path, when the impairment names one. */
  path?: string;
  /** How many entries this impairment covers, when countable. */
  count?: number;
  /**
   * The one lane this impairment shortens. Omitted when it shortens BOTH, which
   * is every impairment except those on a file only one lane reads — so an
   * older reader that does not know the field degrades to the conservative
   * answer, not the permissive one.
   */
  lane?: TranscriptByteLane;
};

/** Whether an impairment shortens `lane`. An unscoped impairment shortens every lane. */
export function impairmentAffectsLane(
  impairment: TranscriptInventoryImpairment,
  lane: TranscriptByteLane
): boolean {
  return impairment.lane === undefined || impairment.lane === lane;
}

/**
 * What happened to one harness during the sweep, across BOTH lanes.
 *
 * A harness with a lane-scoped impairment is `impaired` here — it was not fully
 * seen — while still counting as measured for the other lane. Which lane may
 * state a number is the inventory's per-lane completeness, not this field.
 */
export const TranscriptHarnessOutcome = {
  /** Root readable, nothing impaired it. Its contribution is trustworthy. */
  Measured: "measured",
  /** Not installed on this machine. A REAL zero, not a gap. */
  Absent: "absent",
  /**
   * Installed, but the user switched its collector off.
   *
   * Also a real zero — nothing will parse or upload it, so a measurement that
   * omits it is still complete — but it is a DIFFERENT fact from "not
   * installed", and evidence that says `absent` for a harness the user
   * deliberately disabled tells the reader the wrong story.
   */
  Disabled: "disabled",
  /** Present but not fully seen. */
  Impaired: "impaired",
} as const;
export type TranscriptHarnessOutcome =
  (typeof TranscriptHarnessOutcome)[keyof typeof TranscriptHarnessOutcome];

/** Per-harness outcome, carried so a caller can say WHICH set it counted. */
export type TranscriptHarnessEvidence = {
  harness: TranscriptSourceHarness;
  outcome: TranscriptHarnessOutcome;
};

/** Files and bytes attributed to one exclusion reason. */
export type ExclusionTally = { files: number; bytes: number };

/**
 * How many DISTINCT sessions one harness's discovery enumerated.
 *
 * A count, not a list: the session ids themselves are user data with no
 * onboarding consumer, and `eligibleFiles` already proved how expensive carrying
 * 20,000 of them is. Only harnesses whose enumeration IS a faithful session
 * enumeration appear — see `SESSION_ENUMERATION_IS_FAITHFUL` in the fold — so a
 * harness with no entry is NOT REPORTED rather than zero, and an entry's
 * `sessionCount` is always at least 1.
 */
export type TranscriptHarnessSessionCount = {
  harness: TranscriptSourceHarness;
  sessionCount: number;
};

/** One eligible file, keyed the way the archive lane keys an upload row. */
export type TranscriptEligibleFile = {
  externalSessionId: string;
  fileKey: string;
  bytes: number;
};

/**
 * A byte-volume measurement of the local transcript corpus at one instant.
 *
 * `discoveredBytes`, `eligibleParseBytes` and `excludedBytes` are a partition
 * over the distinct PATHS the parse lane reads. `physicalBytes` is a view over
 * every eligible file in EITHER lane deduped on `(dev, ino)`, answering "how
 * much of this disk is transcripts" — a hardlink is one file and counts once,
 * and a materialized OpenCode projection is real bytes on disk beside the
 * store it was derived from.
 *
 * `attributableRawBytes` and `eligibleFiles` are the UPLOAD lane's set, deduped
 * on `(externalSessionId, fileKey)`: "how many raw bytes would the archive lane
 * account for" — a hardlink is two archive rows and counts twice. For Claude
 * and Codex both lanes read the same files; for OpenCode they do not (see
 * {@link TranscriptByteLane}), so neither set is derivable from the other.
 *
 * So `attributableRawBytes` may legitimately exceed `physicalBytes`. Parse
 * progress is bounded by `eligibleParseBytes`; upload progress is bounded by
 * `attributableRawBytes`; nothing is bounded by `physicalBytes`.
 */
export type TranscriptByteInventory = {
  /**
   * Monotonically increasing per collection. A progress fold closes over it and
   * no-ops a write carrying a stale one, so a superseded sweep cannot move a
   * bar backwards (`collector-manager-pass-scan.ts` `isImportActive` shape).
   */
  inventoryRevision: number;
  /** Whether `discoveredBytes` / `eligibleParseBytes` may be stated as a total. */
  parseCompleteness: TranscriptInventoryCompleteness;
  /**
   * Whether `attributableRawBytes` may be stated as a total.
   *
   * Short on every ordinary machine with OpenCode installed until the sync
   * sweeper has materialized its projection, which happens only after consent:
   * `partial` beside a measured Claude or Codex, `unavailable` when OpenCode is
   * the only harness. The parse lane on that same machine is `complete`.
   */
  uploadCompleteness: TranscriptInventoryCompleteness;
  evidence: readonly TranscriptHarnessEvidence[];
  impairments: readonly TranscriptInventoryImpairment[];
  /** The harnesses this sweep walked. Names the set any copy is allowed to claim. */
  enumeratedHarnesses: readonly TranscriptSourceHarness[];

  discoveredBytes: number;
  eligibleParseBytes: number;
  excludedBytes: number;
  exclusionsByReason: Readonly<
    Record<TranscriptExclusionReason, ExclusionTally>
  >;

  physicalBytes: number;
  attributableRawBytes: number;
  /** The eligible set, deduped by archive-row key. Sums to `attributableRawBytes`. */
  eligibleFiles: readonly TranscriptEligibleFile[];
  /**
   * Distinct sessions discovered per harness (ISS-8346).
   *
   * A DISCOVERY count, deliberately: it counts the sessions this sweep found on
   * disk, including ones whose files the byte lanes then excluded. That is the
   * claim onboarding's "N sessions found" makes, and it is a different question
   * from how many bytes will be parsed.
   *
   * Derived from the same `TranscriptFileRef` stream the byte totals are, so a
   * session whose `main` transcript and every `subagent:` sidechain were
   * enumerated counts ONCE. A harness absent from this list was not counted —
   * never "counted zero" — because for OpenCode the ref source is the
   * consent-gated materialized projection and a zero there would be a
   * fabrication.
   */
  sessionsByHarness: readonly TranscriptHarnessSessionCount[];
  /** Files the upload lane saw and kept out of `eligibleFiles`, by reason. */
  uploadExclusionsByReason: Readonly<
    Record<TranscriptExclusionReason, ExclusionTally>
  >;
};
