/**
 * @file gen-ai-request-telemetry.ts
 * @description ISS-11347: turns the LLM requests a live transcript import parsed
 * into one `emitGenAiRequestEvent` each, once, with its final usage, and only
 * for requests made after telemetry was bound.
 *
 * The source is the transcript's per-request usage (`tokenSeries`), not the
 * harness OTLP spans the desktop can also receive: Claude Code's need two
 * default-off gates and Codex's have no production caller
 * (`collectors/AGENTS.md`), while every harness session has a transcript.
 *
 * A live import re-parses the whole transcript on every change, so the same
 * request is offered many times; the seen-set is what makes it one span. It is
 * capped, and forgetting the oldest-stamped key raises the cutoff past it, so
 * memory is bounded without ever re-emitting a forgotten request. Requests from
 * before the bind are history and are never sent, which is what keeps a first
 * launch from replaying months of usage onto the relay.
 */
import { CODEX_AUTO_REVIEW_LABEL } from "@repo/lib/harness/codex/codex-session-meta";
import {
  Harness,
  type NormalizedSession,
  type NormalizedTokenRecord,
} from "@repo/lib/harness/types";
import { type BillingMode, isSubscription } from "../../shared/billing-mode.js";
import { codexBurstWindowMs } from "../../shared/codex-burst-window.js";
import {
  type EstimateTokenCostInput,
  estimateTokenCost,
} from "../../shared/token-cost.js";
import { detectBillingModeNonBlocking } from "../cost/billing-mode-detector.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import type { DesktopOtelRuntime } from "./app-otel-runtime.js";
import {
  buildGenAiRequestAttributes,
  type DesktopGenAiRequestEventInput,
} from "./app-otel-runtime-gen-ai.js";
import { reportCollectorRecordsDropped } from "./collector-records-dropped-telemetry.js";
import { CollectorRecordsDroppedReason } from "./telemetry-protocol.js";

const SEEN_REQUEST_CAPACITY = 4096;
const PENDING_REQUEST_CAPACITY = 256;

/**
 * A transcript stamp further ahead of this clock than this is corrupt, not
 * skew: the harness writes it on the same machine. Admitting one would also
 * drag the eviction cutoff past every real request that follows it.
 */
const MAX_FUTURE_SKEW_MS = 60_000;

/**
 * Claude writes one transcript line per content block, each with a growing
 * usage snapshot, so the first parse of a request can see a partial count. A
 * request no later one has closed ships once its usage has held this long.
 */
const CLAUDE_SETTLE_MS = 120_000;
const SETTLE_SWEEP_MS = 30_000;

/**
 * Observations that may wait behind a billing-mode probe (ISS-12120). Each
 * session holds at most one slot, so this bounds the distinct sessions.
 */
const DEFERRED_OBSERVATION_CAPACITY = 64;

const LOG_TAG = "gen-ai-request-telemetry";

/**
 * Harnesses whose `tokenSeries` holds one record per API round-trip with a
 * stamp that does not move between parses: Claude (deduped per message) and
 * Codex (one delta per `token_count`). Cursor and Copilot CLI record running
 * totals, so each record is not a request; Copilot chat stamps can fall back to
 * a session-level date that moves as the chat grows; OpenCode's per-request
 * identity is unverified. Emitting any of those would overstate usage.
 */
const PER_REQUEST_SERIES_HARNESSES: ReadonlySet<Harness> = new Set([
  Harness.Claude,
  Harness.Codex,
]);

type GenAiRequestSink = Pick<DesktopOtelRuntime, "emitGenAiRequestEvent">;

type Candidate = {
  key: string;
  record: NormalizedTokenRecord;
  atMs: number;
  withCost: boolean;
};

type UnpricedCandidate = Omit<Candidate, "withCost">;

type HeldRequest = Candidate & { usage: string; changedAtMs: number };

/**
 * One `observeLiveSession` call, as it stood when it was made: the session
 * fields the bridge reads, the clock reading every decision about it uses, and
 * the runtime binding it belongs to.
 */
type Observation = {
  session: LiveSession;
  harness: Harness;
  atMs: number;
  binding: number;
};

export type GenAiRequestTelemetry = {
  /** Start emitting to `runtime` (or stop, with `null`) from now on. */
  bindRuntime: (runtime: GenAiRequestSink | null) => void;
  observeLiveSession: (session: LiveSession, harness: Harness) => void;
};

export function createGenAiRequestTelemetry(
  options: {
    now?: () => number;
    capacity?: number;
    heldCapacity?: number;
    /** Observations that may wait behind a billing-mode probe. */
    deferredCapacity?: number;
    detectBillingMode?: (
      harness: Harness,
      model: string | null
    ) => BillingMode | Promise<BillingMode>;
    log?: (message: string) => void;
  } = {}
): GenAiRequestTelemetry {
  const now = options.now ?? Date.now;
  const detectMode = options.detectBillingMode ?? detectBillingModeNonBlocking;
  const log =
    options.log ?? ((message: string) => gatewayLog.warn(LOG_TAG, message));
  const capacity = Math.max(1, options.capacity ?? SEEN_REQUEST_CAPACITY);
  const heldCapacity = Math.max(
    1,
    options.heldCapacity ?? PENDING_REQUEST_CAPACITY
  );
  const deferredCapacity = Math.max(
    1,
    options.deferredCapacity ?? DEFERRED_OBSERVATION_CAPACITY
  );
  let sink: GenAiRequestSink | null = null;
  let binding = 0;
  let cutoffMs = Number.POSITIVE_INFINITY;
  let sweep: ReturnType<typeof setInterval> | null = null;
  let refused = 0;
  let probing = false;
  const seen = new Map<string, number>();
  const held = new Map<string, HeldRequest>();
  const deferred: Observation[] = [];

  return {
    bindRuntime(runtime) {
      if (sweep) {
        clearInterval(sweep);
        sweep = null;
      }
      sink = runtime;
      binding++;
      cutoffMs = now();
      seen.clear();
      held.clear();
      deferred.length = 0;
      if (runtime) {
        // The only thing that ships a session's last Claude request once the
        // session goes quiet: no further change means no further parse.
        sweep = setInterval(() => {
          // A held request's newer usage may be waiting on the probe; the
          // observation that carries it runs the settle pass when it lands.
          if (probing) {
            return;
          }
          shipSettled(now());
          reportRefused();
        }, SETTLE_SWEEP_MS);
        sweep.unref?.();
      }
    },
    observeLiveSession(session, harness) {
      if (!(sink && PER_REQUEST_SERIES_HARNESSES.has(harness))) {
        return;
      }
      const observation: Observation = {
        session: {
          sessionId: session.sessionId,
          model: session.model,
          startedAt: session.startedAt,
          tokenSeries: session.tokenSeries,
        },
        harness,
        atMs: now(),
        binding,
      };
      if (probing) {
        defer(observation);
      } else {
        observe(observation);
      }
    },
  };

  /**
   * ISS-12120: the billing mode decides whether a request carries its cost, and
   * on macOS deciding it can need a Keychain probe. The non-blocking detector
   * answers synchronously whenever it can, and then this runs exactly as it
   * always has. When it must probe, the observation finishes once the probe
   * settles, and later observations wait behind it in call order, so the
   * seen-set and the held requests see them in the order they were made.
   */
  function observe(observation: Observation): void {
    const candidates = unseenCandidates(observation);
    if (candidates.length === 0) {
      finish(observation, candidates, false);
      return;
    }
    const mode = detectMode(observation.harness, observation.session.model);
    if (typeof mode === "string") {
      finish(observation, candidates, sendsCost(mode));
      return;
    }
    probing = true;
    // Off the caller's stack, a throw here would reach no try/catch: the
    // live-session sink's catch only covers the synchronous call. Log it, as
    // that catch would, and keep draining.
    mode
      .then((resolved) => {
        if (observation.binding === binding) {
          finish(observation, candidates, sendsCost(resolved));
        }
      })
      .catch(logDroppedObservation)
      .finally(() => {
        probing = false;
        drainDeferred();
      });
  }

  function logDroppedObservation(error: unknown): void {
    log(
      `gen_ai request telemetry dropped an observation: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  /**
   * Queue an observation behind a probe. A live import re-parses the whole
   * transcript, so a newer observation of a queued session replaces the queued
   * one. It goes to the tail, never into the old slot: the queue must stay in
   * call order, or the newer observation's later clock could settle another
   * session's held request before that session's queued update runs. Past the
   * cap the oldest waits no longer (bounded memory, and the probe's own
   * deadline keeps the wait under about a second).
   */
  function defer(observation: Observation): void {
    const queued = deferred.findIndex(
      (entry) =>
        entry.harness === observation.harness &&
        entry.session.sessionId === observation.session.sessionId
    );
    if (queued >= 0) {
      deferred.splice(queued, 1);
    }
    deferred.push(observation);
    if (deferred.length > deferredCapacity) {
      deferred.shift();
      log(
        "gen_ai request telemetry dropped a queued observation: the queue behind a billing-mode probe is full"
      );
    }
  }

  function drainDeferred(): void {
    for (
      let next = deferred.shift();
      next !== undefined;
      next = probing ? undefined : deferred.shift()
    ) {
      if (next.binding === binding) {
        try {
          observe(next);
        } catch (error) {
          logDroppedObservation(error);
        }
      }
    }
  }

  function finish(
    observation: Observation,
    candidates: readonly UnpricedCandidate[],
    withCost: boolean
  ): void {
    const priced = candidates.map((candidate) => ({ ...candidate, withCost }));
    if (observation.harness === Harness.Claude) {
      holdUntilSettled(priced, observation.atMs);
    } else {
      shipOutsideOpenReplayWindow(
        observation.session,
        priced,
        observation.atMs
      );
    }
    shipSettled(observation.atMs);
    reportRefused();
  }

  function unseenCandidates({
    session,
    atMs: nowMs,
  }: Observation): UnpricedCandidate[] {
    const latestAcceptedMs = nowMs + MAX_FUTURE_SKEW_MS;
    const candidates: UnpricedCandidate[] = [];
    const occurrences = new Map<string, number>();
    for (const record of session.tokenSeries) {
      const key = requestKey(session.sessionId, record, occurrences);
      const atMs = Date.parse(record.timestamp);
      // NaN fails both comparisons and is skipped too.
      if (
        atMs >= cutoffMs &&
        atMs <= latestAcceptedMs &&
        hasRealModel(record) &&
        !seen.has(key)
      ) {
        candidates.push({ key, record, atMs });
      }
    }
    return candidates;
  }

  /**
   * Perrin Upcott's ruling (ISS-11347, #8059, 2026-09-28): the cost goes only
   * with spend-ledger sessions, so a subscription session sends its model and
   * tokens without one. The mode comes from the detector ingest stamps
   * `billing_mode` with; `headlineCost` counts the unknown ledger as spend, so
   * an undetermined mode keeps its cost.
   */
  function sendsCost(mode: BillingMode): boolean {
    return !isSubscription(mode);
  }

  /**
   * A resumed rollout opens with a replay of the original session's records,
   * freshly stamped, and the parser strips that burst only once it can see all
   * of it (`rebaseReplayedBurst`). So a Codex request stamped inside the
   * rollout's leading window waits, unseen, for a parse after the window
   * closes, which carries the parser's verdict. A session that writes nothing
   * after its first seconds never gets that parse, so its requests from inside
   * the window are not sent.
   */
  function shipOutsideOpenReplayWindow(
    session: LiveSession,
    candidates: readonly Candidate[],
    nowMs: number
  ): void {
    const windowEndMs =
      Date.parse(session.startedAt ?? "") + codexBurstWindowMs();
    const windowOpen = nowMs < windowEndMs;
    for (const candidate of candidates) {
      if (!(windowOpen && candidate.atMs < windowEndMs)) {
        ship(candidate);
      }
    }
  }

  /**
   * Claude sends the next request in a stream (the parent, or one subagent)
   * only after the previous one returned, so any request with a later one in
   * its stream is complete and ships now with its final usage. The latest in
   * each stream is held until a later one arrives or its usage settles.
   */
  function holdUntilSettled(
    candidates: readonly Candidate[],
    nowMs: number
  ): void {
    const latestByStream = new Map<string, number>();
    for (const { record, atMs } of candidates) {
      const stream = record.subagentId ?? "";
      latestByStream.set(
        stream,
        Math.max(latestByStream.get(stream) ?? atMs, atMs)
      );
    }
    for (const candidate of candidates) {
      const latestMs = latestByStream.get(candidate.record.subagentId ?? "");
      if (latestMs !== undefined && candidate.atMs < latestMs) {
        ship(candidate);
      } else {
        hold(candidate, nowMs);
      }
    }
  }

  function hold(candidate: Candidate, nowMs: number): void {
    const usage = usageSignature(candidate.record);
    if (held.get(candidate.key)?.usage === usage) {
      return;
    }
    held.delete(candidate.key);
    held.set(candidate.key, { ...candidate, usage, changedAtMs: nowMs });
    if (held.size <= heldCapacity) {
      return;
    }
    const oldest = held.values().next();
    if (!oldest.done) {
      ship(oldest.value);
    }
  }

  function shipSettled(nowMs: number): void {
    for (const request of [...held.values()]) {
      if (nowMs - request.changedAtMs >= CLAUDE_SETTLE_MS) {
        ship(request);
      }
    }
  }

  function ship({ key, record, atMs, withCost }: Candidate): void {
    held.delete(key);
    if (!sink) {
      return;
    }
    remember(key, atMs);
    const input = toGenAiRequestInput(record, atMs, withCost);
    if (isEmittable(input)) {
      sink.emitGenAiRequestEvent(input);
    } else {
      refused++;
    }
  }

  /** One drop report per pass, never one per request. */
  function reportRefused(): void {
    reportCollectorRecordsDropped({
      reason: CollectorRecordsDroppedReason.GenAiRequestRefused,
      count: refused,
    });
    refused = 0;
  }

  /**
   * Forgets the OLDEST stamp, not the oldest insert: a folded root appends a
   * child's requests after its own, so insertion order is not time order, and
   * raising the cutoff past a newer stamp would drop an older request a later
   * parse still has to offer.
   */
  function remember(key: string, atMs: number): void {
    seen.set(key, atMs);
    if (seen.size <= capacity) {
      return;
    }
    let oldestKey = key;
    let oldestMs = atMs;
    for (const [seenKey, seenMs] of seen) {
      if (seenMs < oldestMs) {
        oldestKey = seenKey;
        oldestMs = seenMs;
      }
    }
    seen.delete(oldestKey);
    cutoffMs = Math.max(cutoffMs, oldestMs + 1);
  }
}

/** The process's one instance; `desktop-services` binds the runtime to it. */
export const genAiRequestTelemetry = createGenAiRequestTelemetry();

/**
 * `inferred` marks a placeholder model, and Codex files review spend under a
 * reviewer label; in both the model that ran is unknown.
 */
function hasRealModel(record: NormalizedTokenRecord): boolean {
  return !record.inferred && record.model !== CODEX_AUTO_REVIEW_LABEL;
}

/**
 * Stable across re-parses of one transcript: only what the request's first
 * line fixes, its stamp and model, plus its place among the records sharing
 * both (two Codex round-trips can share a carried stamp). Never its usage,
 * which grows; never its provenance, which a later line can change (a source
 * id can degrade to unavailable, an in-line sidechain's subagent id follows its
 * latest line); never its array index, which a fold can shift.
 */
function requestKey(
  sessionId: string,
  record: NormalizedTokenRecord,
  occurrences: Map<string, number>
): string {
  const base = [sessionId, record.timestamp, record.model].join("\u0000");
  const occurrence = occurrences.get(base) ?? 0;
  occurrences.set(base, occurrence + 1);
  return `${base}\u0000${occurrence}`;
}

function usageSignature(record: NormalizedTokenRecord): string {
  return [
    record.input,
    record.output,
    record.cacheRead,
    record.cacheWrite,
  ].join(":");
}

function toGenAiRequestInput(
  record: NormalizedTokenRecord,
  atUnixMs: number,
  withCost: boolean
): DesktopGenAiRequestEventInput {
  const costInput: EstimateTokenCostInput = {
    model: record.model,
    inputTokens: record.input,
    outputTokens: record.output,
    cacheReadTokens: record.cacheRead,
    cacheWriteTokens: record.cacheWrite,
    ...(record.cacheWriteTtl
      ? { cacheWrite1hTokens: record.cacheWriteTtl.oneH }
      : {}),
    observedAt: record.timestamp,
  };
  const estimate = estimateTokenCost(costInput);
  return {
    model: record.model,
    inputTokens: record.input,
    outputTokens: record.output,
    cacheReadInputTokens: record.cacheRead,
    cacheCreationInputTokens: record.cacheWrite,
    atUnixMs,
    // A fallback-tier price is another model's rate, not this request's cost.
    ...(withCost && estimate && !estimate.unknownModelFallbackApplied
      ? { costUsd: estimate.costUsd }
      : {}),
  };
}

/** Whether the contract accepts `input`; the runtime refuses it otherwise. */
function isEmittable(input: DesktopGenAiRequestEventInput): boolean {
  try {
    buildGenAiRequestAttributes(input);
    return true;
  } catch {
    return false;
  }
}

type LiveSession = Pick<
  NormalizedSession,
  "sessionId" | "model" | "startedAt" | "tokenSeries"
>;
