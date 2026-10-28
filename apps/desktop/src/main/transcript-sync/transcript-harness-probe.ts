/**
 * @file transcript-harness-probe.ts
 * @description ISS-8506 — decide, per archive-capable harness, whether this
 * machine's transcripts were actually SEEN.
 *
 * Without this the byte inventory cannot tell an empty machine from a locked
 * one. Every enumerator on the discovery path swallows IO errors to `[]` —
 * `claude-home.ts` `safeReaddir`, `parser-utils.ts` `collectJsonlFiles`,
 * `opencode-materialized-discovery.ts` — which is correct for an error-tolerant
 * import and fatal for a measurement: a TCC-denied home directory yields the
 * same `0` as a machine that has never run the tool. Reporting that `0` as a
 * total is exactly the fabricated measurement the ticket forbids.
 *
 * The probing itself is NOT new code. `collectors/engine/file-access-probe.ts`
 * (FEA-3639) already owns it, including the subtlety that it must `opendirSync`
 * rather than `accessSync` because a stat-family check can succeed on a
 * TCC-blocked directory. `harness-scan-roots.ts` already owns the harness→roots
 * registry, including BOTH Codex roots. This module only maps their verdicts
 * onto inventory vocabulary.
 *
 * RULING 1 HOLDS: `harnessScanRoots()` is keyed on the five-member `Harness`
 * enum; this filters to the three archive-capable harnesses
 * `discoverTranscriptFiles` already walks. No cursor or copilot root is probed,
 * enumerated, stat'ed, or counted. Probing the readability of roots we already
 * enumerate is not widening discovery.
 */

import type { Harness } from "@repo/lib/harness/types";
import {
  abbreviateHomePath,
  checkFilePresence,
  checkPathReadable,
  type HarnessScanRoot,
  PathReadability,
} from "../collectors/engine/file-access-probe.js";
import { harnessScanRoots } from "../collectors/engine/harness-scan-roots.js";
import {
  getOpenCodeDbPath,
  getOpenCodeHome,
} from "../collectors/opencode/opencode-home.js";
import { opencodeMaterializedRoot } from "./opencode-materializer.js";
import {
  impairmentAffectsLane,
  TranscriptByteLane,
  TranscriptHarnessOutcome,
  TranscriptImpairmentReason,
  type TranscriptInventoryImpairment,
} from "./transcript-byte-inventory-types.js";
import { TranscriptSourceHarness } from "./transcript-sync-types.js";

/** The archive-capable harnesses, in enumeration order. */
export const ARCHIVE_CAPABLE_HARNESSES: readonly TranscriptSourceHarness[] = [
  TranscriptSourceHarness.Claude,
  TranscriptSourceHarness.Codex,
  TranscriptSourceHarness.OpenCode,
];

/** One harness's verdict plus whatever kept it from being fully measured. */
export type TranscriptHarnessProbe = {
  harness: TranscriptSourceHarness;
  outcome: TranscriptHarnessOutcome;
  impairments: readonly TranscriptInventoryImpairment[];
};

/** Injectable filesystem seams (defaults hit the real filesystem). */
export type TranscriptHarnessProbeDeps = {
  checkReadable: (root: string) => PathReadability;
  checkFile: (filePath: string) => PathReadability;
  scanRoots: (
    isEnabled?: (harness: Harness) => boolean
  ) => readonly HarnessScanRoot[];
  /**
   * Whether the user has this harness's collector switched on.
   *
   * Threaded through to `harnessScanRoots`, which carries the parameter
   * precisely so a probe "never opens a root `CollectorManager` deliberately
   * leaves untouched (FEA-3741) — no incidental TCC touch, and no file-access
   * prompt for a harness that isn't being collected". Probing a disabled
   * harness would also report it measured, feeding a `complete` verdict for a
   * corpus nothing will ever read.
   *
   * Defaults to all-enabled because this lane has no production caller yet; the
   * caller that wires it (ISS-8376) supplies the real settings reader.
   */
  isEnabled: (harness: Harness) => boolean;
  openCodeHome: () => string;
  openCodeDbPath: () => string;
  materializedRoot: () => string;
};

/**
 * Probe every archive-capable harness under `stateDir`.
 *
 * Deliberately does NOT run the OpenCode materializer. Only the sync sweeper
 * writes that projection (`transcript-discovery-sweep.ts`, behind the FEA-3463
 * tier gate that keeps the upload queue from growing before consent), and
 * onboarding — where this measurement is taken — runs before it. A missing
 * projection is therefore an UPLOAD-lane gap only: the parse lane measures
 * `opencode.db` itself and needs no projection to be complete.
 */
export function probeTranscriptHarnesses(
  stateDir: string,
  overrides: Partial<TranscriptHarnessProbeDeps> = {}
): TranscriptHarnessProbe[] {
  // The db path follows the home by default, so a caller that redirects only
  // the home cannot end up probing one install and sizing another.
  const openCodeHome = overrides.openCodeHome ?? getOpenCodeHome;
  const deps: TranscriptHarnessProbeDeps = {
    checkReadable: checkPathReadable,
    checkFile: checkFilePresence,
    scanRoots: harnessScanRoots,
    isEnabled: () => true,
    openCodeHome,
    openCodeDbPath: () => getOpenCodeDbPath(openCodeHome()),
    materializedRoot: () => opencodeMaterializedRoot(stateDir),
    ...overrides,
  };
  const rootsByHarness = new Map<string, readonly string[]>();
  for (const entry of deps.scanRoots(deps.isEnabled)) {
    rootsByHarness.set(entry.harness, entry.roots);
  }
  return ARCHIVE_CAPABLE_HARNESSES.map((harness) => {
    if (!deps.isEnabled(harness)) {
      return {
        harness,
        outcome: TranscriptHarnessOutcome.Disabled,
        impairments: [],
      };
    }
    if (harness === TranscriptSourceHarness.OpenCode) {
      return probeOpenCode(deps);
    }
    return probeDirectoryRoots(
      harness,
      rootsByHarness.get(harness) ?? [],
      deps
    );
  });
}

/**
 * How many harnesses were read cleanly FOR `lane`.
 *
 * Half of that lane's completeness verdict; the impairment count is the other
 * half and belongs to the caller, which sees impairments these probes cannot —
 * an unreadable file, a truncated listing, a cut Codex chain. The rule that
 * combines them lives with that caller, in one place, so the two halves cannot
 * describe different rules.
 *
 * A harness whose only impairments are scoped to the OTHER lane was read
 * cleanly for this one: an unmaterialized OpenCode projection leaves the store
 * the parse lane reads fully measured.
 */
export function countMeasuredHarnesses(
  probes: readonly TranscriptHarnessProbe[],
  lane: TranscriptByteLane
): number {
  return probes.filter((probe) => harnessMeasuredForLane(probe, lane)).length;
}

/** Map a non-readable root verdict onto an impairment, or nothing when absent. */
function impairmentForRoot(
  harness: TranscriptSourceHarness,
  root: string,
  verdict: PathReadability
): TranscriptInventoryImpairment | undefined {
  if (verdict === PathReadability.Blocked) {
    return {
      reason: TranscriptImpairmentReason.RootBlocked,
      harness,
      path: abbreviateHomePath(root),
    };
  }
  if (verdict === PathReadability.Unknown) {
    return {
      reason: TranscriptImpairmentReason.RootUnknown,
      harness,
      path: abbreviateHomePath(root),
    };
  }
  return undefined;
}

/**
 * Claude and Codex: a harness is measured when at least one root read cleanly
 * and none was denied. A harness whose every root is absent is not installed.
 */
function probeDirectoryRoots(
  harness: TranscriptSourceHarness,
  roots: readonly string[],
  deps: TranscriptHarnessProbeDeps
): TranscriptHarnessProbe {
  const impairments: TranscriptInventoryImpairment[] = [];
  let readableRoots = 0;
  for (const root of roots) {
    const verdict = deps.checkReadable(root);
    if (verdict === PathReadability.Readable) {
      readableRoots += 1;
    }
    const impairment = impairmentForRoot(harness, root, verdict);
    if (impairment) {
      impairments.push(impairment);
    }
  }
  return {
    harness,
    outcome: outcomeFor(readableRoots, impairments),
    impairments,
  };
}

/**
 * OpenCode needs two different questions answered against two different paths,
 * and conflating them is how a measurement lies:
 *
 *  - INSTALLED? — the FILE `opencode.db`. Its home DIRECTORY can exist without
 *    it, so probing the directory would call OpenCode installed when it is not.
 *  - READABLE? — the DIRECTORY, which is the granularity a TCC denial applies
 *    at (the same reason `harness-scan-roots.ts` registers the home dir).
 *
 * A third state sits between them: installed, readable, but never materialized.
 * That is the ordinary pre-consent case. It is an impairment, not a zero — but
 * an UPLOAD-lane one: the projection is what the archive lane would send, while
 * the parse lane reads the store this probe just confirmed is present.
 */
function probeOpenCode(
  deps: TranscriptHarnessProbeDeps
): TranscriptHarnessProbe {
  const harness = TranscriptSourceHarness.OpenCode;
  const home = deps.openCodeHome();
  const homeVerdict = deps.checkReadable(home);
  if (homeVerdict !== PathReadability.Readable) {
    const impairment = impairmentForRoot(harness, home, homeVerdict);
    return absentOrImpaired(harness, impairment);
  }

  const dbVerdict = deps.checkFile(deps.openCodeDbPath());
  if (dbVerdict !== PathReadability.Readable) {
    const impairment = impairmentForRoot(
      harness,
      deps.openCodeDbPath(),
      dbVerdict
    );
    return absentOrImpaired(harness, impairment);
  }

  const materialized = deps.materializedRoot();
  const materializedVerdict = deps.checkReadable(materialized);
  if (materializedVerdict === PathReadability.Readable) {
    return {
      harness,
      outcome: TranscriptHarnessOutcome.Measured,
      impairments: [],
    };
  }
  if (materializedVerdict === PathReadability.Absent) {
    return {
      harness,
      outcome: TranscriptHarnessOutcome.Impaired,
      impairments: [
        {
          reason: TranscriptImpairmentReason.OpencodeUnmaterialized,
          harness,
          path: abbreviateHomePath(materialized),
          lane: TranscriptByteLane.Upload,
        },
      ],
    };
  }
  // Blocked or unknown on the PROJECTION root is the same lane as absent: the
  // store this probe already confirmed present is still the parse lane's
  // measured input, whatever happened to the projection directory.
  const impairment = impairmentForRoot(
    harness,
    materialized,
    materializedVerdict
  );
  return {
    harness,
    outcome: TranscriptHarnessOutcome.Impaired,
    impairments: impairment
      ? [{ ...impairment, lane: TranscriptByteLane.Upload }]
      : [],
  };
}

/** No impairment means the path was simply absent — the harness is not installed. */
function absentOrImpaired(
  harness: TranscriptSourceHarness,
  impairment: TranscriptInventoryImpairment | undefined
): TranscriptHarnessProbe {
  if (impairment) {
    return {
      harness,
      outcome: TranscriptHarnessOutcome.Impaired,
      impairments: [impairment],
    };
  }
  return { harness, outcome: TranscriptHarnessOutcome.Absent, impairments: [] };
}

/** A harness is measured only when something read cleanly and nothing was denied. */
function outcomeFor(
  readableRoots: number,
  impairments: readonly TranscriptInventoryImpairment[]
): TranscriptHarnessOutcome {
  if (impairments.length > 0) {
    return TranscriptHarnessOutcome.Impaired;
  }
  if (readableRoots > 0) {
    return TranscriptHarnessOutcome.Measured;
  }
  return TranscriptHarnessOutcome.Absent;
}

/** Measured outright, or impaired only on the lane that is not being asked about. */
function harnessMeasuredForLane(
  probe: TranscriptHarnessProbe,
  lane: TranscriptByteLane
): boolean {
  if (probe.outcome === TranscriptHarnessOutcome.Measured) {
    return true;
  }
  if (probe.outcome !== TranscriptHarnessOutcome.Impaired) {
    return false;
  }
  return (
    probe.impairments.length > 0 &&
    probe.impairments.every(
      (impairment) => !impairmentAffectsLane(impairment, lane)
    )
  );
}
