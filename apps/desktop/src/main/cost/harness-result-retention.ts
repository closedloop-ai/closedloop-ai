/**
 * @file harness-result-retention.ts
 * @description ISS-7332 — durable local retention of Claude Code's raw
 * `{"type":"result"}` stdout envelope.
 *
 * That envelope is the ONLY artifact anywhere that carries the authoritative
 * `total_cost_usd`: stored interactive transcripts and sub-agent transcripts
 * carry per-message `usage` token blocks and no cost at all, and Codex emits no
 * cost metric at any level. Until this module, the envelope was read once by
 * {@link file://./token-usage.ts parseHarnessResult}, narrowed into a struct,
 * and discarded with the work dir — so an extraction bug (or a capture the
 * narrowing rejected) destroyed the figure permanently. That is exactly how the
 * 2026-07-19 → 2026-08-06 window became unbackfillable.
 *
 * WHAT IS RETAINED: the verbatim envelope line only — the accounting record,
 * not the conversation stream around it. The whole capture holds prompts, file
 * contents, and repo data; retaining one line is a materially smaller storage
 * and privacy commitment and stays re-parseable if the extraction logic later
 * proves wrong, which is the failure mode this exists for.
 *
 * PRIVACY BOUNDARY: a retained envelope is LOCAL DURABLE STORAGE, never a
 * telemetry payload. The envelope's own `result` field carries the run's final
 * assistant text, so nothing here may cross a telemetry, log, or Slack seam.
 * {@link retainHarnessResultEnvelope}'s whole output is
 * {@link HarnessResultRetentionOutcome} — ids, sizes, and closed-enum members.
 * The content-bearing exports exist for local recovery; keep them off every
 * log seam. That narrowness is load-bearing, not belt-and-braces: `gatewayLog`
 * entries DO reach the renderer over the `GetLogs` IPC channel.
 *
 * ORDERING: retention runs at the finalizer's COMMON completion seam, before it
 * branches on status, and therefore strictly before any narrowing parse. That is
 * the entire fix — the narrowing parse is the layer that has been wrong before,
 * and a parse-then-retain design loses the only artifact carrying the
 * authoritative cost in exactly the case where the parse is what failed. It also
 * means a FAILED / STOPPED / UNKNOWN run keeps its envelope: Claude writes a
 * `result` line carrying `total_cost_usd` on error subtypes too.
 *
 * SCOPE: this was driven from the loop finalizer, which ran only for
 * non-interactive gateway harness runs. That finalizer was removed with Loops
 * (ISS-12435), so nothing writes new envelopes; the store and its boot sweep
 * age out what earlier builds retained. Interactive, sub-agent, and imported sessions never
 * reach this seam, and a Codex capture reaches it but retains nothing — Codex
 * emits `item.started` / `turn.completed` events and never a `result` envelope,
 * so the identity check below simply finds none. There is deliberately no
 * per-harness branch: the artifact's own presence is the gate.
 */
import { readFileSync } from "node:fs";
import Store from "electron-store";
import { z } from "zod";
import { gatewayLog } from "../logging/gateway-logger.js";
import { reportHarnessResultEnvelopesDropped } from "../telemetry/harness-result-envelopes-dropped-telemetry.js";
import { HarnessResultEnvelopeDropReason } from "../telemetry/telemetry-protocol.js";
import { resolveClaudeOutputPath } from "./token-usage.js";

/** A retained envelope: the verbatim line plus the ids/sizes needed to age it out. */
export type RetainedHarnessResultEnvelope = {
  /** Loop the capture belongs to. One retained envelope per loop; a retry replaces it. */
  loopId: string;
  /** Epoch ms the envelope was retained (drives the retention window). */
  retainedAtMs: number;
  /**
   * The `{"type":"result"}` line exactly as the harness wrote it. Never
   * narrowed, coerced, or re-serialized — re-parseability is the point.
   */
  rawEnvelope: string;
};

/** Terminal state of one retention attempt. Closed set; safe at a log boundary. */
export const HarnessResultRetentionStatus = {
  /** An envelope was found and written to durable storage. */
  Retained: "retained",
  /** The capture was readable and held no `result` envelope (Codex, or a run that never finished one). */
  NoEnvelope: "no_envelope",
  /** No capture file resolved — benign; the run dir was cleaned up. */
  CaptureMissing: "capture_missing",
  /**
   * A capture resolved but could not be read. Kept apart from
   * {@link CaptureMissing} — as `ScanJsonlResult` keeps them apart upstream —
   * because an EACCES/EIO-class fault breaks retention for EVERY run on the
   * machine, which is the systemic silent loss this module exists to prevent.
   */
  CaptureUnreadable: "capture_unreadable",
  /** The store rejected or failed the write. */
  RetentionFailed: "retention_failed",
} as const;
export type HarnessResultRetentionStatus =
  (typeof HarnessResultRetentionStatus)[keyof typeof HarnessResultRetentionStatus];

/**
 * Everything a caller learns about a retention attempt.
 *
 * Deliberately ids, sizes, and closed-enum members only — this is the value
 * that crosses into logs and any future telemetry, so retained content must not
 * be representable here. `apps/desktop/test/harness-result-retention.test.ts`
 * holds a compile-time keys-covered guard plus a runtime walk, so a field added
 * here that could carry content fails rather than leaks.
 */
export type HarnessResultRetentionOutcome = {
  loopId: string;
  status: HarnessResultRetentionStatus;
  /** Byte length of the retained envelope, 0 when nothing was retained. */
  envelopeBytes: number;
  /** Entries held by the store after the write and its prune. */
  retainedEntries: number;
};

export type HarnessResultEnvelopeStoreOptions = {
  /** electron-store directory override (tests point this at a temp dir). */
  cwd?: string;
  /** electron-store file name (without extension). */
  name?: string;
  /** Drop envelopes retained more than this many days ago. Default 90. */
  retentionDays?: number;
  /** Hard cap on retained envelopes, newest kept. Default 250. */
  maxEntries?: number;
  /**
   * Byte BUDGET, newest kept — deliberately not a hard ceiling, and callers must
   * not treat it as one. The newest envelope is always admitted, so the true
   * bound is `maxTotalBytes` plus the size of one envelope: a single line larger
   * than the whole budget is still retained rather than dropped. See
   * {@link HarnessResultEnvelopeStore} for why dropping it would be the one cap
   * capable of recreating the gap this store exists to close. Default 32 MiB.
   */
  maxTotalBytes?: number;
  /** Injectable clock for retention pruning (tests pin it). */
  now?: () => number;
  /**
   * Report corrupt persisted rows to the monitored path. Injectable so a test
   * can assert the signal fires without standing up the telemetry transport;
   * production uses {@link reportHarnessResultEnvelopesDropped}.
   */
  reportDropped?: (input: {
    reason: HarnessResultEnvelopeDropReason;
    count: number;
  }) => void;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_MAX_ENTRIES = 250;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const RESULT_ENVELOPE_TYPE = "result";
const STORE_NAME = "desktop-harness-result-envelopes";
const TAG = "harness-result-retention";

type HarnessResultEnvelopeStoreSchema = {
  envelopes: RetainedHarnessResultEnvelope[];
};

/**
 * The persisted-row contract. The JSON file is a TRUST BOUNDARY — a partial
 * write, a hand edit, or a build that wrote a different shape all arrive here as
 * `unknown` — so it is validated with Zod per the root AGENTS.md rule rather
 * than hand-rolled `typeof` checks.
 *
 * Unknown keys are STRIPPED rather than rejected: a row written by a newer build
 * that added a field is still a perfectly recoverable envelope, and `.strict()`
 * would turn a downgrade into data loss. What must be exact is the three fields
 * the recovery actually needs.
 */
const retainedHarnessResultEnvelopeSchema = z.object({
  loopId: z.string().min(1),
  retainedAtMs: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .refine(Number.isSafeInteger),
  rawEnvelope: z.string().min(1),
});

/** Validate one persisted/incoming record, returning a clean copy or null. */
function sanitizeEnvelope(
  value: unknown
): RetainedHarnessResultEnvelope | null {
  const parsed = retainedHarnessResultEnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Newest first — the order every cap evicts from the tail of. */
function compareEnvelopes(
  a: RetainedHarnessResultEnvelope,
  b: RetainedHarnessResultEnvelope
): number {
  if (a.retainedAtMs !== b.retainedAtMs) {
    return b.retainedAtMs - a.retainedAtMs;
  }
  return a.loopId < b.loopId ? -1 : 1;
}

/**
 * Durable, local, main-process-only storage for retained result envelopes.
 *
 * Every cap evicts OLDEST first, so enforcing a bound can never destroy the
 * envelope of the run that just finished — {@link retain} re-checks that after
 * pruning rather than trusting the ordering, because `compareEnvelopes` breaks a
 * same-millisecond tie on `loopId` and a tie at capacity would otherwise slice
 * off the arrival it just accepted. There is deliberately NO per-envelope size
 * ceiling: a bound that drops a single oversized envelope would be the one cap
 * capable of silently recreating the unrecoverable gap this store exists to
 * close, so total bytes is budgeted instead of individual lines.
 *
 * The retention WINDOW is not a cap and gets no such protection: an envelope
 * older than the window is expired, not evicted, and resurrecting it would defeat
 * the privacy commitment the window is.
 */
export class HarnessResultEnvelopeStore {
  private readonly store: Store<HarnessResultEnvelopeStoreSchema>;
  private readonly retentionDays: number;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly now: () => number;
  private readonly reportDropped: (input: {
    reason: HarnessResultEnvelopeDropReason;
    count: number;
  }) => void;
  private envelopes: RetainedHarnessResultEnvelope[];

  constructor(options?: HarnessResultEnvelopeStoreOptions) {
    this.retentionDays = options?.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxTotalBytes = options?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.now = options?.now ?? Date.now;
    this.reportDropped =
      options?.reportDropped ?? reportHarnessResultEnvelopesDropped;
    this.store = new Store<HarnessResultEnvelopeStoreSchema>({
      name: options?.name ?? STORE_NAME,
      cwd: options?.cwd,
      defaults: { envelopes: [] },
    });

    const persisted = this.store.get("envelopes", []);
    const raw = Array.isArray(persisted) ? persisted : [];
    const sanitized: RetainedHarnessResultEnvelope[] = [];
    let corruptRows = 0;
    for (const candidate of raw) {
      const clean = sanitizeEnvelope(candidate);
      if (clean) {
        sanitized.push(clean);
      } else {
        corruptRows += 1;
      }
    }
    // Counted INSIDE the reject branch, and reported before the rewrite below
    // makes the rows unrecoverable. The load otherwise succeeds silently: this
    // is the only trace that a recovery artifact deleted part of itself.
    if (corruptRows > 0) {
      this.reportCorruptRows(corruptRows);
    }
    const pruned = this.prune(sanitized);
    this.envelopes = pruned;
    if (pruned.length !== raw.length) {
      this.persist();
    }
  }

  /**
   * Retain one envelope, replacing any previous envelope for the same loop, then
   * enforce the retention window and the caps. Returns the entry count that
   * survived, which is what the outcome reports.
   *
   * The caller is told `retained`, so this must not return while the envelope it
   * just accepted is gone — see {@link restoreCapEvicted}.
   */
  retain(envelope: RetainedHarnessResultEnvelope): number {
    const clean = sanitizeEnvelope(envelope);
    if (!clean) {
      throw new Error("harness result envelope failed validation");
    }
    const kept = this.envelopes.filter((held) => held.loopId !== clean.loopId);
    kept.push(clean);
    const fresh = this.applyWindow(kept);
    const capped = this.applyCaps(fresh);
    this.envelopes = fresh.some((held) => held.loopId === clean.loopId)
      ? restoreCapEvicted(capped, clean)
      : capped;
    this.persist();
    return this.envelopes.length;
  }

  /**
   * Apply the retention window (and the caps) on demand, returning how many
   * envelopes it dropped.
   *
   * Expiry otherwise runs only when the lazy store is constructed or another
   * envelope is retained, so a user who stops running eligible loops keeps a
   * plaintext record on disk indefinitely past the window. This is the seam the
   * boot-owned sweep drives — see `harness-result-retention-sweep.ts`.
   */
  pruneExpired(): number {
    const before = this.envelopes.length;
    const pruned = this.prune(this.envelopes);
    const dropped = before - pruned.length;
    if (dropped > 0) {
      this.envelopes = pruned;
      this.persist();
    }
    return dropped;
  }

  /** Every retained envelope, newest first. Local recovery only — never a wire payload. */
  list(): RetainedHarnessResultEnvelope[] {
    return [...this.envelopes].sort(compareEnvelopes);
  }

  /** The retained envelope for a loop, or null. */
  getByLoopId(loopId: string): RetainedHarnessResultEnvelope | null {
    return this.envelopes.find((held) => held.loopId === loopId) ?? null;
  }

  clear(): void {
    this.envelopes = [];
    this.persist();
  }

  /** Apply the retention window, then the entry cap, then the byte budget. */
  private prune(
    envelopes: RetainedHarnessResultEnvelope[]
  ): RetainedHarnessResultEnvelope[] {
    return this.applyCaps(this.applyWindow(envelopes));
  }

  /** Drop everything retained before the window opened. Expiry, not eviction. */
  private applyWindow(
    envelopes: RetainedHarnessResultEnvelope[]
  ): RetainedHarnessResultEnvelope[] {
    const cutoff = this.now() - this.retentionDays * MS_PER_DAY;
    return envelopes.filter((held) => held.retainedAtMs >= cutoff);
  }

  /**
   * The entry cap, then the byte budget, both newest-first.
   *
   * The budget is NOT a hard ceiling: when nothing has been admitted yet the
   * newest envelope goes in whatever its size, so the real bound is
   * `maxTotalBytes` plus one envelope. That is deliberate — dropping a single
   * oversized line is the one eviction that would recreate the unrecoverable
   * gap this store exists to close — and it is stated on
   * {@link HarnessResultEnvelopeStoreOptions.maxTotalBytes} so nothing
   * downstream sizes itself against a bound that does not hold.
   */
  private applyCaps(
    envelopes: RetainedHarnessResultEnvelope[]
  ): RetainedHarnessResultEnvelope[] {
    const capped = [...envelopes]
      .sort(compareEnvelopes)
      .slice(0, this.maxEntries);

    const withinBudget: RetainedHarnessResultEnvelope[] = [];
    let bytes = 0;
    for (const held of capped) {
      const size = Buffer.byteLength(held.rawEnvelope, "utf-8");
      if (bytes + size > this.maxTotalBytes && withinBudget.length > 0) {
        break;
      }
      bytes += size;
      withinBudget.push(held);
    }
    return withinBudget;
  }

  private reportCorruptRows(count: number): void {
    try {
      this.reportDropped({
        reason: HarnessResultEnvelopeDropReason.CorruptPersistedRow,
        count,
      });
    } catch (error) {
      // The monitored signal is best-effort: a telemetry transport that is not
      // up yet must never take the cost store down with it.
      gatewayLog.warn(
        TAG,
        `corrupt-row report failed: ${error instanceof Error ? error.name : "non-error throw"}`
      );
    }
  }

  private persist(): void {
    this.store.set("envelopes", this.envelopes);
  }
}

/**
 * Put back an envelope a CAP evicted, displacing the tail entry that beat it.
 *
 * `compareEnvelopes` breaks a `retainedAtMs` tie on `loopId`, so an arrival that
 * shares a millisecond with a held envelope can sort behind it and be sliced off
 * by the entry cap or skipped by the byte budget — while the caller is told
 * `retained` and `getByLoopId` then returns null for it. Rare (it needs a
 * same-millisecond collision at capacity) but it breaks the store's stated
 * contract outright, and a caller that trusts `retained` has no other copy.
 */
function restoreCapEvicted(
  capped: RetainedHarnessResultEnvelope[],
  arrival: RetainedHarnessResultEnvelope
): RetainedHarnessResultEnvelope[] {
  if (capped.some((held) => held.loopId === arrival.loopId)) {
    return capped;
  }
  const restored = capped.slice(0, Math.max(0, capped.length - 1));
  restored.push(arrival);
  return restored.sort(compareEnvelopes);
}

let sharedStore: HarnessResultEnvelopeStore | null = null;

/**
 * Lazily-built process-wide store. Lazy because electron-store resolves its
 * directory through Electron's `app`, which is not available at module-import
 * time on every path that imports the finalizer.
 *
 * Exported for the boot-owned sweep (`harness-result-retention-sweep.ts`), which
 * has to prune the SAME instance the finalizer writes through — a second store
 * over the same file would race it. It exposes no envelope content itself.
 */
export function getSharedHarnessResultEnvelopeStore(): HarnessResultEnvelopeStore {
  sharedStore ??= new HarnessResultEnvelopeStore();
  return sharedStore;
}

/** Injectable seams for tests; production defaults to the real implementations. */
export type HarnessResultRetentionDeps = {
  store?: HarnessResultEnvelopeStore;
  /** Retention time in epoch ms (defaults to `Date.now`). */
  now?: () => number;
  /**
   * Byte offset the CURRENT attempt began writing the capture at —
   * `LocalJob.jsonlPreSpawnOffset`, taken by the spawn path immediately before
   * the harness starts. Omitted (jobs persisted before ISS-7332) means "scan the
   * whole file", which is the pre-boundary behaviour.
   */
  fromByteOffset?: number;
};

/**
 * The LAST raw `{"type":"result"}` line of a capture, verbatim, or null.
 *
 * Line IDENTITY only. Each line is JSON-parsed solely to read `type`, and the
 * original text is what comes back — no field is read, narrowed, coerced, or
 * re-serialized. Keeping every one of those out of this function is what makes
 * a retained envelope survive an extraction bug in `parseHarnessResult`.
 *
 * The last envelope wins for the same reason `parseHarnessResult` takes it: the
 * harness appends to the capture when a work dir is reused, so an earlier line
 * belongs to the previous attempt. `content` must already be narrowed to the
 * current attempt's bytes — see {@link currentAttemptText}; the last line of a
 * WHOLE capture is still a previous attempt's when this attempt wrote none.
 */
export function findLastResultEnvelopeLine(content: string): string | null {
  let last: string | null = null;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      typeof entry === "object" &&
      entry !== null &&
      (entry as Record<string, unknown>).type === RESULT_ENVELOPE_TYPE
    ) {
      last = trimmed;
    }
  }
  return last;
}

/**
 * Retain the run's raw result envelope, if it has one.
 *
 * MUST be called BEFORE `parseHarnessResult`. That ordering is the entire fix:
 * the narrowing parse is the layer that has been wrong before, and a
 * parse-then-retain design loses the only artifact carrying the authoritative
 * cost in exactly the case where the parse is what failed.
 *
 * Fail-closed. A missing capture, an unreadable file, a capture with no
 * envelope, or a store failure all resolve to a status — never a throw — so
 * retention can never break loop finalization.
 */
export function retainHarnessResultEnvelope(
  claudeWorkDir: string,
  loopId: string,
  deps: HarnessResultRetentionDeps = {}
): HarnessResultRetentionOutcome {
  const now = deps.now ?? Date.now;
  let content: string;
  try {
    const outputFile = resolveClaudeOutputPath(claudeWorkDir);
    if (outputFile === null) {
      return unretained(loopId, HarnessResultRetentionStatus.CaptureMissing);
    }
    content = currentAttemptText(readFileSync(outputFile), deps.fromByteOffset);
  } catch {
    return unretained(loopId, HarnessResultRetentionStatus.CaptureUnreadable);
  }

  const rawEnvelope = findLastResultEnvelopeLine(content);
  if (rawEnvelope === null) {
    return unretained(loopId, HarnessResultRetentionStatus.NoEnvelope);
  }

  try {
    const retainedEntries = (
      deps.store ?? getSharedHarnessResultEnvelopeStore()
    ).retain({
      loopId,
      retainedAtMs: now(),
      rawEnvelope,
    });
    return {
      loopId,
      status: HarnessResultRetentionStatus.Retained,
      envelopeBytes: Buffer.byteLength(rawEnvelope, "utf-8"),
      retainedEntries,
    };
  } catch {
    return unretained(loopId, HarnessResultRetentionStatus.RetentionFailed);
  }
}

function unretained(
  loopId: string,
  status: HarnessResultRetentionStatus
): HarnessResultRetentionOutcome {
  return { loopId, status, envelopeBytes: 0, retainedEntries: 0 };
}

/**
 * The one rendering of a retention attempt that may cross a log boundary.
 *
 * Exists so the boundary is a tested seam rather than a call-site convention:
 * it reads only {@link HarnessResultRetentionOutcome}, so it cannot render
 * retained content even if a caller has the envelope in hand.
 */
export function describeHarnessResultRetention(
  outcome: HarnessResultRetentionOutcome
): string {
  return `loopId=${outcome.loopId} harnessResultRetention status=${outcome.status} envelopeBytes=${outcome.envelopeBytes} retainedEntries=${outcome.retainedEntries}`;
}

/**
 * The bytes the CURRENT attempt appended to the capture, as text.
 *
 * The harness APPENDS to `claude-output.jsonl` when a work dir is reused, so a
 * `result` line ahead of this attempt's pre-spawn offset belongs to a PREVIOUS
 * run. Without this boundary an attempt that emits no envelope of its own — a
 * Codex run in a reused dir, or a Claude run truncated before its result — would
 * retain the previous attempt's line and file another loop's cost under this
 * loop id, which is worse than retaining nothing: the figure is wrong rather
 * than absent, and nothing downstream can tell.
 *
 * An offset past the file's end means the capture was truncated or replaced
 * since the offset was taken, so the recorded boundary no longer describes this
 * file and scanning the whole thing is the honest fallback. An absent or
 * non-positive offset means the same (a job persisted before ISS-7332).
 */
function currentAttemptText(buffer: Buffer, fromByteOffset?: number): string {
  const offset =
    typeof fromByteOffset === "number" &&
    Number.isSafeInteger(fromByteOffset) &&
    fromByteOffset > 0
      ? fromByteOffset
      : 0;
  if (offset === 0 || offset > buffer.byteLength) {
    return buffer.toString("utf-8");
  }
  return buffer.subarray(offset).toString("utf-8");
}
