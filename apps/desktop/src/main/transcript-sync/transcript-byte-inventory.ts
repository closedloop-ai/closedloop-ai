/**
 * @file transcript-byte-inventory.ts
 * @description ISS-8506 - measure the byte volume of the local transcript
 * corpus, honestly.
 *
 * This is the producer half of the onboarding "we found N GB of transcripts"
 * claim. Its whole discipline is the ticket's one hard rule: **never emit a
 * fabricated total.** Unreadable, unstable or partial input yields `partial` or
 * `unavailable` with evidence - never a plausible zero, never a made-up figure.
 *
 * ONE ENUMERATION. The numerator and the denominator both come from a single
 * {@link discoverTranscriptFilesWithEvidence} call. That is the fix for the
 * defect the ticket names: `defaultDeps.listOpencodeMaterializedFiles` returns
 * `[]`, so a denominator taken from a second, differently-configured discovery
 * would omit OpenCode while the OpenCode collector parses it. Sharing the source
 * closes that by construction, and widening discovery would not have.
 *
 * TWO LANES, AND OPENCODE READS DIFFERENT FILES IN EACH. Claude and Codex are
 * parsed and uploaded from the same JSONL, so one entry credits both lanes.
 * OpenCode is parsed from `opencode.db` (plus WAL/SHM) and uploaded from the
 * JSONL projection the sync sweeper materializes after consent. So the store
 * credits the PARSE lane only and the projection the UPLOAD lane only - never
 * both, or a materialized machine would count every OpenCode byte twice - and
 * each lane carries its own completeness. An unmaterialized projection is an
 * upload-lane gap; the parse number beside it is complete (ruling of
 * 2026-09-02 on #6451).
 *
 * WHY NOT `lastSize`. The persisted `lastSize` column is the only existing byte
 * proxy and it is unusable here: the discovery sweep skips its observe-write
 * entirely while cloud-archive consent is off (`transcript-discovery-sweep.ts`).
 * Onboarding IS the pre-consent moment, so that table is empty exactly when this
 * runs. We stat during discovery instead.
 *
 * NOTHING IS COUNTED THAT WILL NOT BE READ. A harness whose collector the user
 * switched off is skipped by DISCOVERY too, not just by the probe. The probe
 * decides once and enumeration obeys it, so evidence saying `disabled` and a
 * total containing that harness's bytes cannot coexist - and a root the
 * `CollectorManager` deliberately leaves untouched is not opened here either.
 *
 * SUBTREES THAT WERE NEVER READ ARE REPORTED. Every enumerator swallows a
 * nested `EACCES` and stops at a depth bound, which is right for an
 * error-tolerant import and fatal for a measurement: a readable root with one
 * denied project directory yields a short listing that would otherwise publish
 * as a complete total. The walkers keep the tolerance and now take an optional
 * skip sink (`directory-walk-skip.ts`), which this module turns into
 * impairments. Per-FILE `lstat` failures were already visible, because that
 * stat is this module's own call.
 *
 * KNOWN GAP, named rather than hidden: these modules ship with tests as their
 * only caller. That is the ticket's stated shape - an independent producer lane
 * that unblocks ISS-8376's volume fields. Deliberate, not unfinished plumbing.
 */
import fs from "node:fs";
import type { ClaudeSubagentTranscriptFile } from "../collectors/claude/claude-home.js";
import {
  listAllTranscriptFiles as listClaudeMainTranscriptFiles,
  listClaudeSubagentTranscriptFiles,
} from "../collectors/claude/claude-home.js";
import { listAllRolloutFiles } from "../collectors/codex/codex-home.js";
import {
  getOpenCodeHome,
  listOpenCodeStoreFiles,
} from "../collectors/opencode/opencode-home.js";
import {
  listOpencodeMaterializedFiles,
  type OpencodeMaterializedFile,
} from "./opencode-materialized-discovery.js";
import {
  classifyEntryPath,
  countDiscoveredSessions,
  createInventoryAccumulator,
  measuredEntries,
  type TranscriptEntryStat,
  type TranscriptInventoryDeps,
  type TranscriptRawStoreFile,
} from "./transcript-byte-inventory-fold.js";
import {
  impairmentAffectsLane,
  type TranscriptByteInventory,
  TranscriptByteLane,
  type TranscriptHarnessEvidence,
  TranscriptHarnessOutcome,
  TranscriptImpairmentReason,
  TranscriptInventoryCompleteness,
  type TranscriptInventoryImpairment,
} from "./transcript-byte-inventory-types.js";
import { discoverTranscriptFilesWithEvidence } from "./transcript-discovery.js";
import {
  countMeasuredHarnesses,
  probeTranscriptHarnesses,
  type TranscriptHarnessProbe,
  type TranscriptHarnessProbeDeps,
} from "./transcript-harness-probe.js";
import {
  type TranscriptFileRef,
  TranscriptSourceHarness,
} from "./transcript-sync-types.js";
import {
  createTranscriptWalkSkipLedger,
  type TranscriptWalkSkipLedger,
} from "./transcript-walk-skip-ledger.js";

/**
 * The most files this measurement will read from any one harness listing.
 *
 * Bounds the per-file WORK downstream of enumeration, which is where the cost
 * is: `mapCodexRolloutsById` does a synchronous 64 KB-bounded read per rollout,
 * and every ref is `lstat`ed. A wall-clock deadline cannot interrupt any of it -
 * it all completes before the first `await` - so the cap is applied to the INPUT
 * listings, ahead of those reads.
 *
 * It does NOT bound the `readdirSync` walk itself, which runs to completion
 * inside the shared harness collectors before this ever sees a listing. Those
 * collectors are the live sync lane's enumerators too and they walk unbounded on
 * every sweep today; making them stop early is a change to every harness's
 * import, not to this measurement, so it is not made here.
 *
 * Truncating rather than discarding follows `claude-desktop-origin.ts`'s
 * `MAX_SIDECAR_FILES`, the precedent the ticket names: keep what was measured
 * and say the measurement is short. Discarding throws away a good prefix to
 * report nothing.
 */
export const MAX_INVENTORY_FILES = 20_000;

/**
 * `lstat` one transcript entry.
 *
 * Deliberately NOT `transcript-sync-executor.ts`'s `statTranscriptFile`, whose
 * `{size, mtimeMs}` shape is otherwise exactly right. That helper calls `stat`,
 * which FOLLOWS symlinks - so a symlink reports its target's size and can never
 * be excluded as a symlink - and it returns neither the link flag nor
 * `(dev, ino)`, without which a hardlink counts as two distinct files on disk.
 * Both are load-bearing here, so this is a sibling rather than a reuse.
 */
export function lstatTranscriptEntry(
  sourcePath: string
): TranscriptEntryStat | undefined {
  try {
    const stats = fs.lstatSync(sourcePath);
    return {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      isSymbolicLink: stats.isSymbolicLink(),
      isFile: stats.isFile(),
      dev: stats.dev,
      ino: stats.ino,
    };
  } catch {
    return undefined;
  }
}

/** Truncate a listing to {@link MAX_INVENTORY_FILES}, reporting what it dropped. */
export function capListing<T>(items: readonly T[]): {
  items: T[];
  truncated: number;
} {
  if (items.length <= MAX_INVENTORY_FILES) {
    return { items: [...items], truncated: 0 };
  }
  return {
    items: items.slice(0, MAX_INVENTORY_FILES),
    truncated: items.length - MAX_INVENTORY_FILES,
  };
}

/**
 * Build the inventory from an already-enumerated ref list plus the raw stores
 * only the parse lane reads.
 *
 * The reconciliation identity `discoveredBytes === eligibleParseBytes +
 * excludedBytes` is enforced by construction in `createInventoryAccumulator`
 * (`transcript-byte-inventory-fold.ts`), not asserted in a comment: every
 * parse-lane byte flows through one `creditBytes` call that credits exactly one
 * of the two buckets and adds to `discovered` in the same statement, so no code
 * path can move one without the other. Path dedup happens HERE, before any
 * stat, so the fold never sees the same file twice.
 *
 * Classification precedence is pinned and ordered deliberately: path dedup
 * (before any stat) -> `lstat` -> stat failure -> symlink -> non-regular ->
 * **unstable** -> empty -> eligible. `unstable` is checked BEFORE `empty`
 * because a file being written right now is often momentarily zero bytes, and
 * calling that "empty" reports a real, growing transcript as nothing to parse.
 *
 * A file-level impairment is scoped to the lane(s) that read the file: an
 * unreadable projection shortens the upload total, an unreadable store shortens
 * the parse total, and an unreadable Claude transcript shortens both.
 */
export function buildTranscriptByteInventory(
  refs: readonly TranscriptFileRef[],
  rawStores: readonly TranscriptRawStoreFile[],
  probes: readonly TranscriptHarnessProbe[],
  extraImpairments: readonly TranscriptInventoryImpairment[],
  deps: TranscriptInventoryDeps,
  scanStart: number
): TranscriptByteInventory {
  const accumulator = createInventoryAccumulator();
  const seenPaths = new Set<string>();
  for (const entry of measuredEntries(refs, rawStores)) {
    if (seenPaths.has(entry.sourcePath)) {
      // Not an exclusion: the same path reached us twice, so there is one file
      // to measure and it is already measured. Counting it again inflates
      // `discoveredBytes`; excluding it inflates `excludedBytes`.
      continue;
    }
    seenPaths.add(entry.sourcePath);
    accumulator.absorb(
      entry,
      classifyEntryPath(entry.sourcePath, deps, scanStart)
    );
  }
  const measured = accumulator.result();

  const impairments: TranscriptInventoryImpairment[] = [
    ...probes.flatMap((probe) => probe.impairments),
    ...extraImpairments,
    ...measured.fileImpairments,
  ];
  for (const lane of [TranscriptByteLane.Parse, TranscriptByteLane.Upload]) {
    const harness = measured.precisionLostAt[lane];
    if (!harness) {
      continue;
    }
    // The harness whose file the sum ran out of room on. Not "the harness that
    // is too big" - it is the one being credited at the moment that lane's
    // total left the exact-integer range, which is a fact rather than an
    // attribution.
    impairments.push({
      reason: TranscriptImpairmentReason.TotalExceedsPrecision,
      harness,
      lane,
    });
  }

  const completenessForLane = (lane: TranscriptByteLane) =>
    completenessFor(
      countMeasuredHarnesses(probes, lane),
      impairments.filter((impairment) =>
        impairmentAffectsLane(impairment, lane)
      ).length
    );

  return {
    inventoryRevision: deps.nextRevision(),
    parseCompleteness: completenessForLane(TranscriptByteLane.Parse),
    uploadCompleteness: completenessForLane(TranscriptByteLane.Upload),
    evidence: probes.map(
      (probe): TranscriptHarnessEvidence => ({
        harness: probe.harness,
        outcome: probe.outcome,
      })
    ),
    impairments,
    // The set the sweep actually WALKED, which is what names the harnesses a
    // caller's copy may claim. A disabled harness has an evidence entry saying
    // so, but `cappedListers` never called its lister, so listing it here would
    // claim a switched-off source was inventoried.
    enumeratedHarnesses: probes
      .filter((probe) => probe.outcome !== TranscriptHarnessOutcome.Disabled)
      .map((probe) => probe.harness),
    discoveredBytes: measured.discoveredBytes,
    eligibleParseBytes: measured.eligibleParseBytes,
    excludedBytes: measured.excludedBytes,
    exclusionsByReason: measured.exclusionsByReason,
    physicalBytes: measured.physicalBytes,
    attributableRawBytes: measured.attributableRawBytes,
    eligibleFiles: measured.eligibleFiles,
    // Counted from the SAME ref stream the byte totals are folded from, so the
    // two answers can never describe different enumerations.
    sessionsByHarness: countDiscoveredSessions(refs),
    uploadExclusionsByReason: measured.uploadExclusionsByReason,
  };
}

/** Every seam {@link collectTranscriptByteInventory} reaches the world through. */
export type TranscriptCollectionDeps = TranscriptInventoryDeps & {
  now: () => number;
  discover: typeof discoverTranscriptFilesWithEvidence;
  probeHarnesses: (
    stateDir: string,
    probeOverrides?: Partial<TranscriptHarnessProbeDeps>
  ) => TranscriptHarnessProbe[];
  probeOverrides: Partial<TranscriptHarnessProbeDeps>;
  listClaudeMainFiles: () => string[];
  listClaudeSubagentFiles: () => ClaudeSubagentTranscriptFile[];
  listCodexRolloutFiles: () => string[];
  /**
   * The materialized OpenCode projection files under `stateDir` - the UPLOAD
   * lane's OpenCode source.
   *
   * Load-bearing: `discoverTranscriptFiles`'s own default for this seam is
   * `() => []`, so a caller that does not supply it enumerates NO OpenCode
   * files while the harness probe still reports OpenCode measured - a confident
   * total missing an entire harness. That omission is the defect this ticket
   * exists to close, so the default here is the real lister bound to
   * `stateDir`, matching `desktop-transcript-sync-factory.ts`.
   */
  listOpencodeMaterializedFiles: () => OpencodeMaterializedFile[];
  /**
   * OpenCode's raw store files (`opencode.db` + existing WAL/SHM) - the PARSE
   * lane's OpenCode source, which exists whether or not a projection does.
   */
  listOpencodeStoreFiles: () => string[];
};

/**
 * Measure this machine's transcript corpus.
 *
 * Synchronous, and fully dependency-injected. It does NOT stand up a utility
 * process - this lane has no production caller yet (the transport is
 * ISS-8376's), and a worker entrypoint, protocol and build entry for a function
 * nothing calls would be speculative. The injection is what makes it
 * thread-agnostic: a caller that needs it off the main thread hosts this exact
 * function in a worker without a line changing here. It is deliberately not
 * `async` either, because nothing in it awaits - a Promise return would only
 * dress a synchronous sweep up as an asynchronous one.
 */
export function collectTranscriptByteInventory(
  stateDir: string,
  overrides: Partial<TranscriptCollectionDeps> = {}
): TranscriptByteInventory {
  const now = overrides.now ?? Date.now;
  const discover = overrides.discover ?? discoverTranscriptFilesWithEvidence;
  const probeHarnesses = overrides.probeHarnesses ?? probeTranscriptHarnesses;

  // Captured BEFORE enumeration: a file written while we are walking must read
  // as unstable, and a `scanStart` taken afterwards would call it stable.
  const scanStart = now();
  const probes = probeHarnesses(stateDir, overrides.probeOverrides ?? {});

  // The probe is the ONE decision about which harnesses this sweep touches.
  // Reading the enabled predicate a second time here would let evidence and
  // enumeration disagree; deriving the set from the probes cannot.
  const disabledHarnesses = new Set(
    probes
      .filter((probe) => probe.outcome === TranscriptHarnessOutcome.Disabled)
      .map((probe) => probe.harness)
  );

  const extraImpairments: TranscriptInventoryImpairment[] = [];
  const walkSkips = createTranscriptWalkSkipLedger();
  const { listOpencodeStoreFiles, ...discoveryListers } = cappedListers(
    overrides,
    stateDir,
    extraImpairments,
    disabledHarnesses,
    walkSkips
  );
  const discovered = discover(discoveryListers);
  const rawStores = listOpencodeStoreFiles().map(
    (sourcePath): TranscriptRawStoreFile => ({
      harness: TranscriptSourceHarness.OpenCode,
      sourcePath,
    })
  );
  if (discovered.orphanCount > 0) {
    extraImpairments.push({
      reason: TranscriptImpairmentReason.CodexLinkageTruncated,
      harness: TranscriptSourceHarness.Codex,
      count: discovered.orphanCount,
    });
  }
  extraImpairments.push(...walkSkips.impairments());

  return buildTranscriptByteInventory(
    discovered.refs,
    rawStores,
    probes,
    extraImpairments,
    {
      lstatEntry: overrides.lstatEntry ?? lstatTranscriptEntry,
      nextRevision: overrides.nextRevision ?? mintInventoryRevision,
    },
    scanStart
  );
}

let lastMintedRevision = 0;

/** Monotonic within a process; a progress fold no-ops anything older. */
export function mintInventoryRevision(): number {
  lastMintedRevision += 1;
  return lastMintedRevision;
}

/**
 * The completeness rule.
 *
 * An ABSENT root is not an impairment - a machine with no Codex installed has
 * genuinely zero Codex bytes, and that is a complete measurement. `unavailable`
 * is what makes this honest at the other end: something blocked us AND nothing
 * was measured, so there is no number to state at all.
 */
function completenessFor(
  measured: number,
  impairedCount: number
): TranscriptInventoryCompleteness {
  if (impairedCount === 0) {
    return TranscriptInventoryCompleteness.Complete;
  }
  if (measured === 0) {
    return TranscriptInventoryCompleteness.Unavailable;
  }
  return TranscriptInventoryCompleteness.Partial;
}

/**
 * Wrap the harness listers so {@link MAX_INVENTORY_FILES} binds BEFORE the
 * per-rollout metadata reads, recording any truncation as an impairment.
 *
 * The real listers are the default rather than an opt-in: the cap exists to
 * bound production work, so a wrapper that only applied when a test injected a
 * lister would bound nothing on a real machine.
 */
function cappedListers(
  overrides: Partial<TranscriptCollectionDeps>,
  stateDir: string,
  capImpairments: TranscriptInventoryImpairment[],
  disabledHarnesses: ReadonlySet<TranscriptSourceHarness>,
  walkSkips: TranscriptWalkSkipLedger
): {
  listClaudeMainFiles: () => string[];
  listClaudeSubagentFiles: () => ClaudeSubagentTranscriptFile[];
  listCodexRolloutFiles: () => string[];
  listOpencodeMaterializedFiles: () => OpencodeMaterializedFile[];
  listOpencodeStoreFiles: () => string[];
} {
  // `lane` scopes the truncation impairment to the lane that reads the listing;
  // omitted for a listing both lanes read.
  const cap = <T>(
    lister: () => T[],
    harness: TranscriptSourceHarness,
    lane?: TranscriptByteLane
  ) => {
    if (disabledHarnesses.has(harness)) {
      // A real zero, and NOT an impairment: nothing will parse or upload this
      // harness, so a total that omits it is still complete. Returning `[]`
      // rather than filtering afterwards is what keeps the root unopened.
      return () => [];
    }
    return () => {
      const { items, truncated } = capListing(lister());
      if (truncated > 0) {
        capImpairments.push({
          reason: TranscriptImpairmentReason.InputCapTruncated,
          harness,
          count: truncated,
          ...(lane ? { lane } : {}),
        });
      }
      return items;
    };
  };
  // Bound to the harness whose gap it would be. An INJECTED lister gets no sink
  // - a supplied listing is the caller's own enumeration and has no subtree we
  // could have failed to read.
  const claudeSkips = {
    onSkip: walkSkips.sinkFor(TranscriptSourceHarness.Claude),
  };
  const codexSkips = {
    onSkip: walkSkips.sinkFor(TranscriptSourceHarness.Codex),
  };
  // The projection walk is the upload lane's alone; the store is not walked.
  const opencodeSkips = {
    onSkip: walkSkips.sinkFor(
      TranscriptSourceHarness.OpenCode,
      TranscriptByteLane.Upload
    ),
  };
  // The same seam the probe resolves the home through, so a caller that
  // redirects the probe cannot end up probing one directory and measuring
  // another.
  const openCodeHome =
    overrides.probeOverrides?.openCodeHome ?? getOpenCodeHome;
  return {
    listClaudeMainFiles: cap(
      overrides.listClaudeMainFiles ??
        (() => listClaudeMainTranscriptFiles(claudeSkips)),
      TranscriptSourceHarness.Claude
    ),
    listClaudeSubagentFiles: cap(
      overrides.listClaudeSubagentFiles ??
        (() => listClaudeSubagentTranscriptFiles(claudeSkips)),
      TranscriptSourceHarness.Claude
    ),
    listCodexRolloutFiles: cap(
      overrides.listCodexRolloutFiles ??
        (() => listAllRolloutFiles(codexSkips)),
      TranscriptSourceHarness.Codex
    ),
    listOpencodeMaterializedFiles: cap(
      overrides.listOpencodeMaterializedFiles ??
        (() => listOpencodeMaterializedFiles(stateDir, opencodeSkips)),
      TranscriptSourceHarness.OpenCode,
      TranscriptByteLane.Upload
    ),
    listOpencodeStoreFiles: cap(
      overrides.listOpencodeStoreFiles ??
        (() => listOpenCodeStoreFiles(openCodeHome())),
      TranscriptSourceHarness.OpenCode,
      TranscriptByteLane.Parse
    ),
  };
}
