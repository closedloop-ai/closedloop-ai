import "server-only";

import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import type { SelectedPullRequestEvidenceResult } from "@repo/api/src/types/selected-pull-request-evidence";

export const SELECTED_PULL_REQUEST_ACQUISITION_WINDOW_MS = 60_000;
export const SELECTED_PULL_REQUEST_EVIDENCE_MAX_STARTS = 8;
export const SELECTED_PULL_REQUEST_CONTENT_MAX_ACTIVE = 4;
export const SELECTED_PULL_REQUEST_CONTENT_MAX_STARTS = 16;
export const SELECTED_PULL_REQUEST_ACQUISITION_MAX_ENTRIES = 10_000;
const CONTENT_CONCURRENCY_RETRY_AFTER_MS = 1000;

/** Stable authenticated principal and GitHub PR resource for one budget. */
export type SelectedPullRequestAcquisitionKey = {
  organizationId: string;
  userId: string;
  repositoryFullName: string;
  pullRequestNumber: number;
};

/** Precise admission failures that callers can project into a typed response. */
export const SelectedPullRequestAcquisitionDenialReason = {
  EvidenceBudgetExhausted: "evidence_budget_exhausted",
  EvidenceRetiring: "evidence_retiring",
  ContentBudgetExhausted: "content_budget_exhausted",
  ContentConcurrencyExhausted: "content_concurrency_exhausted",
  CapacityExhausted: "capacity_exhausted",
} as const;
export type SelectedPullRequestAcquisitionDenialReason =
  (typeof SelectedPullRequestAcquisitionDenialReason)[keyof typeof SelectedPullRequestAcquisitionDenialReason];

export type SelectedPullRequestAcquisitionDenial = {
  admitted: false;
  reason: SelectedPullRequestAcquisitionDenialReason;
  retryAfterSeconds: number;
};

export type SelectedPullRequestAcquisitionAdmission<T> =
  | { admitted: true; value: T }
  | SelectedPullRequestAcquisitionDenial;

export type SelectedPullRequestContentAdmission =
  | { admitted: true; release: () => void }
  | SelectedPullRequestAcquisitionDenial;

export type SelectedPullRequestEvidenceAcquisitionBudgetOptions = {
  contentMaxActive?: number;
  contentMaxStarts?: number;
  evidenceMaxStarts?: number;
  maxEntries?: number;
  now?: () => number;
  windowMs?: number;
};

type StartWindow = {
  resetAt: number;
  starts: number;
};

type EvidenceFlight<Evidence> = {
  controller: AbortController;
  generation: number;
  promise: Promise<Evidence>;
  retiring: boolean;
  subscribers: number;
};

type AcquisitionEntry<Evidence> = {
  activeContent: number;
  content: StartWindow;
  evidence: StartWindow;
  evidenceFlight?: EvidenceFlight<Evidence>;
};

/**
 * Best-effort process-local protection for selected-PR evidence and content.
 *
 * Evidence callers sharing a principal and PR join one in-flight provider
 * observation. Subscriber cancellation is local until the final subscriber
 * leaves, at which point the shared provider signal is aborted. Completed
 * evidence is never retained, so this is single-flight coalescing rather than
 * a freshness cache. Fixed-window starts, active content permits, idle expiry,
 * and a hard entry cap bound work and memory on each serverless instance.
 * Under hard memory pressure, the oldest entry with no flight or content
 * permit may be reclaimed before its window expires. That can forget
 * best-effort process-local accounting, but active provider work is never
 * evicted or detached.
 */
export class SelectedPullRequestEvidenceAcquisitionBudget<Evidence> {
  private readonly contentMaxActive: number;
  private readonly contentMaxStarts: number;
  private readonly entries = new Map<string, AcquisitionEntry<Evidence>>();
  private readonly evidenceMaxStarts: number;
  private generation = 0;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly windowMs: number;

  constructor(
    options: SelectedPullRequestEvidenceAcquisitionBudgetOptions = {}
  ) {
    this.contentMaxActive =
      options.contentMaxActive ?? SELECTED_PULL_REQUEST_CONTENT_MAX_ACTIVE;
    this.contentMaxStarts =
      options.contentMaxStarts ?? SELECTED_PULL_REQUEST_CONTENT_MAX_STARTS;
    this.evidenceMaxStarts =
      options.evidenceMaxStarts ?? SELECTED_PULL_REQUEST_EVIDENCE_MAX_STARTS;
    this.maxEntries =
      options.maxEntries ?? SELECTED_PULL_REQUEST_ACQUISITION_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
    this.windowMs =
      options.windowMs ?? SELECTED_PULL_REQUEST_ACQUISITION_WINDOW_MS;
  }

  /** Join or start the key's evidence observation without retaining its result. */
  acquireEvidence(
    key: SelectedPullRequestAcquisitionKey,
    signal: AbortSignal,
    factory: (signal: AbortSignal) => Promise<Evidence>
  ): Promise<SelectedPullRequestAcquisitionAdmission<Evidence>> {
    signal.throwIfAborted();
    const now = this.now();
    const mapKey = acquisitionMapKey(key);
    this.pruneIdle(now);

    const existing = this.entries.get(mapKey);
    if (existing?.evidenceFlight) {
      if (existing.evidenceFlight.retiring) {
        return Promise.resolve(
          denial(
            SelectedPullRequestAcquisitionDenialReason.EvidenceRetiring,
            now + CONTENT_CONCURRENCY_RETRY_AFTER_MS,
            now
          )
        );
      }
      return this.subscribe(existing, existing.evidenceFlight, signal);
    }

    const entryResult = this.getOrCreateEntry(mapKey, now);
    if (!entryResult.admitted) {
      return Promise.resolve(entryResult);
    }
    const entry = entryResult.value;
    resetWindowIfExpired(entry.evidence, now, this.windowMs);
    if (entry.evidence.starts >= this.evidenceMaxStarts) {
      return Promise.resolve(
        denial(
          SelectedPullRequestAcquisitionDenialReason.EvidenceBudgetExhausted,
          entry.evidence.resetAt,
          now
        )
      );
    }

    entry.evidence.starts += 1;
    const flight = this.startEvidenceFlight(mapKey, entry, factory);
    return this.subscribe(entry, flight, signal);
  }

  /** Acquire one content permit; release is safe to call repeatedly. */
  acquireContent(
    key: SelectedPullRequestAcquisitionKey
  ): SelectedPullRequestContentAdmission {
    const now = this.now();
    const mapKey = acquisitionMapKey(key);
    this.pruneIdle(now);
    const entryResult = this.getOrCreateEntry(mapKey, now);
    if (!entryResult.admitted) {
      return entryResult;
    }
    const entry = entryResult.value;
    resetWindowIfExpired(entry.content, now, this.windowMs);
    if (entry.activeContent >= this.contentMaxActive) {
      return denial(
        SelectedPullRequestAcquisitionDenialReason.ContentConcurrencyExhausted,
        now + CONTENT_CONCURRENCY_RETRY_AFTER_MS,
        now
      );
    }
    if (entry.content.starts >= this.contentMaxStarts) {
      return denial(
        SelectedPullRequestAcquisitionDenialReason.ContentBudgetExhausted,
        entry.content.resetAt,
        now
      );
    }

    entry.activeContent += 1;
    entry.content.starts += 1;
    let released = false;
    return {
      admitted: true,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        entry.activeContent -= 1;
        this.deleteIfIdleExpired(mapKey, entry, this.now());
      },
    };
  }

  private startEvidenceFlight(
    mapKey: string,
    entry: AcquisitionEntry<Evidence>,
    factory: (signal: AbortSignal) => Promise<Evidence>
  ): EvidenceFlight<Evidence> {
    const controller = new AbortController();
    this.generation += 1;
    const generation = this.generation;
    let operation: Promise<Evidence>;
    try {
      operation = Promise.resolve(factory(controller.signal));
    } catch (error) {
      operation = Promise.reject(error);
    }
    const flight: EvidenceFlight<Evidence> = {
      controller,
      generation,
      promise: operation,
      retiring: false,
      subscribers: 0,
    };
    flight.promise = operation.finally(() => {
      if (entry.evidenceFlight?.generation === generation) {
        entry.evidenceFlight = undefined;
        this.deleteIfIdleExpired(mapKey, entry, this.now());
      }
    });
    entry.evidenceFlight = flight;
    return flight;
  }

  private subscribe(
    entry: AcquisitionEntry<Evidence>,
    flight: EvidenceFlight<Evidence>,
    signal: AbortSignal
  ): Promise<SelectedPullRequestAcquisitionAdmission<Evidence>> {
    flight.subscribers += 1;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) {
          return false;
        }
        finished = true;
        signal.removeEventListener("abort", onAbort);
        flight.subscribers -= 1;
        return true;
      };
      const onAbort = () => {
        if (!finish()) {
          return;
        }
        if (
          flight.subscribers === 0 &&
          entry.evidenceFlight?.generation === flight.generation
        ) {
          flight.retiring = true;
          flight.controller.abort();
        }
        reject(signal.reason ?? abortError());
      };

      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      flight.promise.then(
        (value) => {
          if (finish()) {
            resolve({ admitted: true, value });
          }
        },
        (error: unknown) => {
          if (finish()) {
            reject(error);
          }
        }
      );
    });
  }

  private getOrCreateEntry(
    mapKey: string,
    now: number
  ):
    | { admitted: true; value: AcquisitionEntry<Evidence> }
    | SelectedPullRequestAcquisitionDenial {
    const existing = this.entries.get(mapKey);
    if (existing) {
      return { admitted: true, value: existing };
    }
    if (this.entries.size >= this.maxEntries) {
      this.evictOldestReclaimableIdleEntry();
      if (this.entries.size >= this.maxEntries) {
        return denial(
          SelectedPullRequestAcquisitionDenialReason.CapacityExhausted,
          now + 1000,
          now
        );
      }
    }
    const entry: AcquisitionEntry<Evidence> = {
      activeContent: 0,
      content: emptyWindow(),
      evidence: emptyWindow(),
    };
    this.entries.set(mapKey, entry);
    return { admitted: true, value: entry };
  }

  /** Reclaim one settled/released entry without ever disrupting active work. */
  private evictOldestReclaimableIdleEntry(): void {
    for (const [mapKey, entry] of this.entries) {
      if (!entry.evidenceFlight && entry.activeContent === 0) {
        this.entries.delete(mapKey);
        return;
      }
    }
  }

  private pruneIdle(now: number): void {
    for (const [mapKey, entry] of this.entries) {
      this.deleteIfIdleExpired(mapKey, entry, now);
    }
  }

  private deleteIfIdleExpired(
    mapKey: string,
    entry: AcquisitionEntry<Evidence>,
    now: number
  ): void {
    if (
      !entry.evidenceFlight &&
      entry.activeContent === 0 &&
      windowIsIdleExpired(entry.evidence, now) &&
      windowIsIdleExpired(entry.content, now)
    ) {
      this.entries.delete(mapKey);
    }
  }
}

/** Production process-local budget; callers must not treat it as fleet-global. */
export const selectedPullRequestEvidenceAcquisitionBudget =
  new SelectedPullRequestEvidenceAcquisitionBudget<SelectedPullRequestEvidenceResult>();

function acquisitionMapKey(key: SelectedPullRequestAcquisitionKey): string {
  return JSON.stringify([
    key.organizationId,
    key.userId,
    normalizeRepoFullName(key.repositoryFullName),
    key.pullRequestNumber,
  ]);
}

function emptyWindow(): StartWindow {
  return { resetAt: 0, starts: 0 };
}

function resetWindowIfExpired(
  window: StartWindow,
  now: number,
  windowMs: number
): void {
  if (window.starts === 0 || now >= window.resetAt) {
    window.resetAt = now + windowMs;
    window.starts = 0;
  }
}

function windowIsIdleExpired(window: StartWindow, now: number): boolean {
  return window.starts === 0 || now >= window.resetAt;
}

function denial(
  reason: SelectedPullRequestAcquisitionDenialReason,
  resetAt: number,
  now: number
): SelectedPullRequestAcquisitionDenial {
  return {
    admitted: false,
    reason,
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
  };
}

function abortError(): DOMException {
  return new DOMException(
    "Selected pull-request acquisition aborted",
    "AbortError"
  );
}
