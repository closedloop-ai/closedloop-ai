/**
 * @file parse-quarantine.ts
 * @description ISS-4444: a bounded, PERSISTED dead-letter store for transcript
 * sources whose historical parse keeps wedging (a catastrophic-regex-backtrack /
 * CPU-spin that never settles — see `bounded-parse.ts`). The manager records a
 * failed-this-pass attempt for such a source; after `maxAttempts` the source is
 * QUARANTINED so it is not re-parsed on every launch (which would re-wedge the
 * worker turn and re-peg a CPU core each boot). The store survives restarts (a
 * best-effort JSON file, mirroring `catchup-cache.ts`), keyed by absolute source
 * path, so a poison transcript is quarantined ONCE, not every cold start.
 *
 * This is deliberately a SEPARATE store from the catchup cache: the catchup cache
 * says "this file was successfully imported, skip it", whereas the quarantine says
 * "this file poisons the parser, stop retrying it". A quarantined source is never
 * marked seen in the catchup cache, so if a human deletes the quarantine file (or
 * the transcript is edited so its identity changes) it is re-attempted from scratch.
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  type QuarantinedStageCounts,
  SourceTimeoutStage,
} from "../../../shared/ingest-quarantine-contract.js";

/**
 * Bump when the persisted quarantine format changes so a differently-shaped file
 * from an older build is discarded wholesale rather than mis-parsed.
 */
const PERSIST_VERSION = 1;

/**
 * ISS-4444: conservative default number of wedging passes a source is tolerated
 * before it is quarantined. Small enough that a genuinely-poison transcript stops
 * pegging a core within a couple of launches, large enough that a one-off wedge
 * (e.g. the OS thrashing during a cold boot) does not permanently quarantine a
 * healthy transcript.
 */
export const DEFAULT_PARSE_QUARANTINE_MAX_ATTEMPTS = 3;

/**
 * ISS-4444 (codex P1): a cheap content-changed fingerprint for a source file
 * ({mtimeMs, size} — the same pair `catchup-cache.ts` uses). Stored with a
 * quarantine entry so that editing/replacing a corrected transcript at the same
 * path invalidates the entry and lets the source be re-attempted, rather than the
 * path-only key leaving `isQuarantined` true forever. `null` means "no
 * fingerprint available" (the stat failed); a null on either side is treated
 * conservatively as "cannot prove it changed" so a poison source stays quarantined.
 */
export type QuarantineFingerprint = {
  mtimeMs: number;
  size: number;
} | null;

/**
 * ISS-6115 (wongk review): the two stages make different claims about a source,
 * so they need different exits. {@link SourceTimeoutStage.Parse} is a claim about
 * the transcript BYTES, and its only honest exit is the bytes changing — which is
 * exactly what the fingerprint keys on (ISS-4444). {@link SourceTimeoutStage.Import}
 * is a claim about the SINK: a wedged or restarting DB host produces it as readily
 * as an oversized transcript does, so keying its exit on the transcript's bytes
 * means a recovered host still skips an UNCHANGED healthy transcript forever. That
 * is the eventual-consistency violation `main/sync/AGENTS.md` forbids — a transient
 * failure must retain retry eligibility — so it also expires; see
 * {@link IMPORT_QUARANTINE_COOLDOWN_MS}. The vocabulary itself is shared with the
 * renderer (the copy differs by stage) and lives in the shared contract.
 */
export const IMPORT_QUARANTINE_COOLDOWN_MS = 6 * 60 * 60_000;

type QuarantineEntry = {
  /** Wedging-parse attempts observed so far for this source. */
  attempts: number;
  /** True once `attempts >= maxAttempts` — the source is no longer retried. */
  quarantined: boolean;
  /**
   * ISS-4444 (codex P1): the source fingerprint at the last recorded failure. A
   * later pass whose fingerprint DIFFERS means the file changed (a human fixed the
   * transcript), so the stale entry is discarded and the source re-attempted.
   */
  fingerprint: QuarantineFingerprint;
  /**
   * ISS-6115: which stage recorded the last failure. STICKY to `Parse` — a source
   * that has ever wedged the PARSER keeps the durable, bytes-keyed quarantine even
   * if a later import also stalls, because re-parsing it re-pegs a CPU core on
   * every launch and no sink recovery makes that safe.
   */
  stage: SourceTimeoutStage;
  /** When the source crossed the threshold, for the import-stage cooldown. */
  quarantinedAt: number | null;
};

export type ParseQuarantine = {
  /**
   * True if the source has reached the quarantine threshold (skip parsing it).
   * When `fingerprint` is supplied and DIFFERS from the entry's stored
   * fingerprint, the source has changed since it was quarantined: the stale entry
   * is cleared and this returns false so the corrected source is re-attempted.
   */
  isQuarantined(source: string, fingerprint?: QuarantineFingerprint): boolean;
  /**
   * True if the store holds ANY entry (quarantined or merely failing) for this
   * source. Lets a caller skip the per-source freshness `stat` for the common case
   * of a source with no entry, since `isQuarantined` short-circuits to false there
   * regardless of the fingerprint.
   */
  hasEntry(source: string): boolean;
  /**
   * Record one wedging-parse attempt for a source and return whether it is NOW
   * quarantined (attempts reached the threshold this call). Marks the store dirty.
   * The optional `fingerprint` is stored so a later content change invalidates the
   * entry; a fingerprint that differs from the stored one resets the attempt count
   * (a changed file starts its wedge tally over).
   */
  recordFailure(
    source: string,
    fingerprint?: QuarantineFingerprint,
    stage?: SourceTimeoutStage
  ): boolean;
  /** Clear any recorded state for a source (e.g. it parsed cleanly at last). */
  clear(source: string): void;
  /** Number of sources currently quarantined (surfaced to the FTUE UI). */
  quarantinedCount(): number;
  /**
   * ISS-6115 (wongk review): the same population SPLIT BY the stage that
   * quarantined it, because the renderer copy differs — a parse wedge means the
   * transcript could not be READ, an import stall means it was read and could not
   * be SAVED, and only the latter can leave a session partly written.
   */
  quarantinedCountsByStage(): QuarantinedStageCounts;
  /** Persist the store to disk (best-effort; no-op when not dirty / no path). */
  flush(): void;
  /** Drop entries whose source is no longer present in `currentPaths`. */
  pruneTo(currentPaths: string[]): void;
  readonly persisted: boolean;
};

/**
 * Zod validator for a persisted fingerprint ({mtimeMs, size}). `nullish` so a
 * missing/null value loads as absent (legacy pre-fingerprint entries) rather than
 * failing the whole entry.
 */
const quarantineFingerprintSchema = z
  .object({
    mtimeMs: z.number(),
    size: z.number().nonnegative(),
  })
  .nullish();

/**
 * Zod validator for one persisted entry. This is unknown JSON at a persistence
 * boundary (wongk review, ISS-4444), so validate it with Zod per the root rule
 * rather than hand-rolled `typeof` checks. `attempts` is constrained to a
 * nonnegative integer so a hand-edited/corrupt `attempts: -100` cannot smuggle a
 * negative count past the threshold check and delay quarantine indefinitely;
 * `quarantined` is derived from the threshold at load time, so its persisted
 * value is intentionally ignored here.
 */
const quarantineEntrySchema = z.object({
  attempts: z.number().int().nonnegative(),
  // ISS-4444 (codex P1): optional so entries persisted before fingerprinting
  // shipped load without a fingerprint (they behave as before until their next
  // recorded failure stamps one) — additive, version-skew safe.
  fingerprint: quarantineFingerprintSchema,
  // ISS-6115: additive for the same reason. Every entry written before this
  // shipped is a PARSE quarantine (the import bound did not charge the store at
  // all), so an absent stage loads as `parse` — the durable, bytes-keyed
  // behaviour those entries already had. `quarantinedAt` is likewise absent on
  // them, which the cooldown reads as "no expiry recorded" and leaves alone.
  stage: z
    .enum([SourceTimeoutStage.Parse, SourceTimeoutStage.Import])
    .nullish(),
  quarantinedAt: z.number().nullish(),
});

/** Parse one persisted entry defensively; unknown/invalid shapes are dropped. */
function parseQuarantineEntry(value: unknown): QuarantineEntry | null {
  const parsed = quarantineEntrySchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  return {
    attempts: parsed.data.attempts,
    quarantined: false,
    fingerprint: parsed.data.fingerprint ?? null,
    stage: parsed.data.stage ?? SourceTimeoutStage.Parse,
    quarantinedAt: parsed.data.quarantinedAt ?? null,
  };
}

/**
 * ISS-4444 (codex P1): do two fingerprints describe the SAME file content? Two
 * present fingerprints match iff both mtime and size agree. A null on either side
 * means we cannot prove the file changed, so we conservatively report "same" — a
 * poison source without a readable stat stays quarantined rather than re-wedging
 * the parser every boot.
 */
function fingerprintsMatch(
  a: QuarantineFingerprint,
  b: QuarantineFingerprint
): boolean {
  if (a === null || b === null) {
    return true;
  }
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

export function createParseQuarantine(
  options: {
    persistPath?: string;
    maxAttempts?: number;
    /** Injected so the import-stage cooldown is drivable from tests. */
    now?: () => number;
    cooldownMs?: number;
  } = {}
): ParseQuarantine {
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? IMPORT_QUARANTINE_COOLDOWN_MS;
  const persistPath =
    typeof options.persistPath === "string" && options.persistPath.length > 0
      ? options.persistPath
      : null;
  // The attempt threshold is the conservative default; the injected `maxAttempts`
  // option is the only override (the test seam). There is intentionally no
  // environment knob — ISS-4444 requires quarantine after N attempts, not an
  // operator-configurable threshold outside the documented environment contract.
  const maxAttempts = Math.max(
    1,
    Math.floor(options.maxAttempts ?? DEFAULT_PARSE_QUARANTINE_MAX_ATTEMPTS)
  );

  const entries = new Map<string, QuarantineEntry>();
  let dirty = false;

  if (persistPath) {
    try {
      const parsed = JSON.parse(readFileSync(persistPath, "utf8")) as {
        version?: number;
        entries?: Record<string, unknown>;
      };
      const persistedEntries =
        parsed?.version === PERSIST_VERSION ? parsed.entries : undefined;
      if (persistedEntries && typeof persistedEntries === "object") {
        for (const [key, value] of Object.entries(persistedEntries)) {
          const entry = parseQuarantineEntry(value);
          if (entry) {
            // Re-derive `quarantined` from the current threshold so lowering the
            // env override can retire a borderline entry, and raising it can give
            // a previously-quarantined source another attempt.
            entry.quarantined = entry.attempts >= maxAttempts;
            entries.set(key, entry);
          }
        }
      }
    } catch {
      /* missing or corrupt quarantine file — start empty, non-fatal */
    }
  }

  function isQuarantined(
    source: string,
    fingerprint?: QuarantineFingerprint
  ): boolean {
    const entry = entries.get(source);
    if (entry?.quarantined !== true) {
      return false;
    }
    // ISS-4444 (codex P1): the transcript at this path was corrected/replaced
    // since it was quarantined — its fingerprint no longer matches. Discard the
    // stale entry so the source is re-attempted from scratch rather than skipped
    // forever behind a path-only key.
    if (
      fingerprint !== undefined &&
      !fingerprintsMatch(entry.fingerprint, fingerprint)
    ) {
      entries.delete(source);
      dirty = true;
      return false;
    }
    // ISS-6115 (wongk review): an IMPORT-stage quarantine is a claim about the
    // SINK, so it must not be keyed on the transcript's bytes. Once its cooldown
    // elapses the source is eligible again — a recovered DB host no longer skips
    // an unchanged healthy transcript forever. The entry is kept (not deleted) at
    // one below the threshold, so this is a single PROBE: if the source stalls
    // again it re-quarantines on that one attempt instead of spending a whole
    // fresh budget.
    if (importCooldownElapsed(entry)) {
      entry.attempts = Math.max(0, maxAttempts - 1);
      entry.quarantined = false;
      entry.quarantinedAt = null;
      dirty = true;
      return false;
    }
    return true;
  }

  /** Has an import-stage entry outlived its cooldown? */
  function importCooldownElapsed(entry: QuarantineEntry): boolean {
    return (
      entry.stage === SourceTimeoutStage.Import &&
      entry.quarantinedAt !== null &&
      now() - entry.quarantinedAt >= cooldownMs
    );
  }

  function hasEntry(source: string): boolean {
    return entries.has(source);
  }

  function recordFailure(
    source: string,
    fingerprint?: QuarantineFingerprint,
    stage: SourceTimeoutStage = SourceTimeoutStage.Parse
  ): boolean {
    const existing = entries.get(source);
    // A changed file starts its wedge tally over: if the fingerprint differs from
    // the one on record, treat this as a fresh source rather than accreting onto a
    // prior (now-stale) file's attempts.
    const carryOver =
      existing &&
      (fingerprint === undefined ||
        fingerprintsMatch(existing.fingerprint, fingerprint));
    const entry: QuarantineEntry = carryOver
      ? existing
      : {
          attempts: 0,
          quarantined: false,
          fingerprint: fingerprint ?? null,
          stage,
          quarantinedAt: null,
        };
    entry.attempts += 1;
    if (fingerprint !== undefined) {
      entry.fingerprint = fingerprint;
    }
    // Sticky to Parse: a source that has ever wedged the parser keeps the durable
    // bytes-keyed quarantine, whatever a later import does.
    if (entry.stage !== SourceTimeoutStage.Parse) {
      entry.stage = stage;
    }
    const nowQuarantined = entry.attempts >= maxAttempts;
    entry.quarantined = nowQuarantined;
    entry.quarantinedAt = nowQuarantined ? now() : null;
    entries.set(source, entry);
    dirty = true;
    return nowQuarantined;
  }

  function clear(source: string): void {
    if (entries.delete(source)) {
      dirty = true;
    }
  }

  function quarantinedCountsByStage(): QuarantinedStageCounts {
    const counts = emptyStageCounts();
    for (const entry of entries.values()) {
      if (entry.quarantined) {
        counts[entry.stage] += 1;
      }
    }
    return counts;
  }

  function quarantinedCount(): number {
    return totalStageCounts(quarantinedCountsByStage());
  }

  function pruneTo(currentPaths: string[]): void {
    const keep = new Set(currentPaths);
    for (const key of entries.keys()) {
      if (!keep.has(key)) {
        entries.delete(key);
        dirty = true;
      }
    }
  }

  function flush(): void {
    if (!(persistPath && dirty)) {
      return;
    }
    // shafty023 review (ISS-4444): write to a same-directory temp file and
    // atomically rename it over the store, and clear `dirty` only AFTER the write
    // succeeds. The prior code cleared `dirty` up front and wrote in place, so a
    // write failure was not retryable (the next flush no-oped) and a crash /
    // partial write could truncate the last valid JSON — which would make the next
    // launch discard every quarantine attempt and re-parse the poison sources this
    // store exists to skip. The rename is atomic on the same filesystem, so a
    // reader (this or the next process) always sees either the old valid file or
    // the new complete one, never a truncated one.
    const tmpPath = `${persistPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      mkdirSync(path.dirname(persistPath), { recursive: true });
      const out: Record<string, QuarantineEntry> = {};
      for (const [key, value] of entries) {
        out[key] = value;
      }
      writeFileSync(
        tmpPath,
        JSON.stringify({ version: PERSIST_VERSION, entries: out })
      );
      renameSync(tmpPath, persistPath);
      dirty = false;
    } catch {
      // Best-effort persistence — the store stays correct in memory and `dirty`
      // stays set so a later flush retries. Clean up the temp file if the failure
      // was after it was written; leaving the previous valid store untouched.
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        /* the temp file may not exist — ignore */
      }
    }
  }

  return {
    isQuarantined,
    hasEntry,
    recordFailure,
    clear,
    quarantinedCount,
    quarantinedCountsByStage,
    pruneTo,
    flush,
    persisted: persistPath != null,
  };
}

/** Absolute path to the persisted parse-quarantine store for a named source. */
export function parseQuarantinePath(stateDir: string, name: string): string {
  return path.join(stateDir, `parse-quarantine-${name}.json`);
}

/**
 * ISS-6115: sources quarantined across every collector's store, split by the
 * stage that quarantined them. The renderer needs the split, not just the total,
 * because "couldn't be read" is only true of the parse-stage population.
 */
export function quarantinedCountsByStage(
  stores: Iterable<ParseQuarantine>
): QuarantinedStageCounts {
  const counts = emptyStageCounts();
  for (const store of stores) {
    const storeCounts = store.quarantinedCountsByStage();
    for (const stage of Object.values(SourceTimeoutStage)) {
      counts[stage] += storeCounts[stage];
    }
  }
  return counts;
}

/** Total sources quarantined across every collector's store. */
export function totalQuarantinedCount(
  stores: Iterable<ParseQuarantine>
): number {
  return totalStageCounts(quarantinedCountsByStage(stores));
}

function emptyStageCounts(): QuarantinedStageCounts {
  return { [SourceTimeoutStage.Parse]: 0, [SourceTimeoutStage.Import]: 0 };
}

function totalStageCounts(counts: QuarantinedStageCounts): number {
  let total = 0;
  for (const stage of Object.values(SourceTimeoutStage)) {
    total += counts[stage];
  }
  return total;
}
