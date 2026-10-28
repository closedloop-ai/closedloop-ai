/**
 * @file transcript-byte-inventory-fixtures.ts
 * @description ISS-8506 — the shared fixtures for the byte-inventory suites.
 *
 * The suite is split by responsibility: `transcript-byte-inventory.test.ts`
 * covers the pure fold (`buildTranscriptByteInventory`, `capListing`,
 * classification precedence, the reconciliation identity), and
 * `transcript-byte-inventory-enumeration.test.ts` covers what the sweep
 * actually walks (the harness probes, `collectTranscriptByteInventory`, and the
 * walk-skip plumbing). Both need the same synthetic ref and stat, so they live
 * here rather than being copied into each.
 */
import { buildTranscriptByteInventory } from "../src/main/transcript-sync/transcript-byte-inventory.js";
import type {
  TranscriptEntryStat,
  TranscriptRawStoreFile,
} from "../src/main/transcript-sync/transcript-byte-inventory-fold.js";
import {
  TranscriptByteLane,
  TranscriptHarnessOutcome,
  TranscriptImpairmentReason,
} from "../src/main/transcript-sync/transcript-byte-inventory-types.js";
import type { TranscriptHarnessProbe } from "../src/main/transcript-sync/transcript-harness-probe.js";
import {
  TRANSCRIPT_MAIN_FILE_KEY,
  type TranscriptFileRef,
  TranscriptSourceHarness,
} from "../src/main/transcript-sync/transcript-sync-types.js";

/** The instant every fixture sweep starts. A stat older than this is settled. */
export const SCAN_START = 10_000;

export function ref(
  sourcePath: string,
  externalSessionId = "sess-1",
  fileKey = TRANSCRIPT_MAIN_FILE_KEY,
  sourceHarness: TranscriptSourceHarness = TranscriptSourceHarness.Claude
): TranscriptFileRef {
  return { externalSessionId, fileKey, sourceHarness, sourcePath };
}

export function stat(
  overrides: Partial<TranscriptEntryStat> = {}
): TranscriptEntryStat {
  return {
    size: 100,
    mtimeMs: SCAN_START - 1000,
    isSymbolicLink: false,
    isFile: true,
    dev: 1,
    ino: 1,
    ...overrides,
  };
}

export function measuredProbes(): TranscriptHarnessProbe[] {
  return [
    {
      harness: TranscriptSourceHarness.Claude,
      outcome: TranscriptHarnessOutcome.Measured,
      impairments: [],
    },
  ];
}

/** The probe an ordinary OpenCode install reports before consent. */
export function unmaterializedOpencodeProbe(): TranscriptHarnessProbe {
  return {
    harness: TranscriptSourceHarness.OpenCode,
    outcome: TranscriptHarnessOutcome.Impaired,
    impairments: [
      {
        reason: TranscriptImpairmentReason.OpencodeUnmaterialized,
        harness: TranscriptSourceHarness.OpenCode,
        path: "~/state/transcript-materialized/opencode",
        lane: TranscriptByteLane.Upload,
      },
    ],
  };
}

export function opencodeStore(sourcePath: string): TranscriptRawStoreFile {
  return { harness: TranscriptSourceHarness.OpenCode, sourcePath };
}

export function build(
  refs: readonly TranscriptFileRef[],
  stats: Record<string, TranscriptEntryStat | undefined>,
  probes: TranscriptHarnessProbe[] = measuredProbes(),
  rawStores: readonly TranscriptRawStoreFile[] = []
) {
  return buildTranscriptByteInventory(
    refs,
    rawStores,
    probes,
    [],
    {
      lstatEntry: (sourcePath) => stats[sourcePath],
      nextRevision: () => 7,
    },
    SCAN_START
  );
}
