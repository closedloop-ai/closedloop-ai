"use client";

import type { BranchListStatusOrderingResponse } from "@repo/api/src/types/branch-list-contract";
import { useEffect, useState } from "react";
import type { BranchesDataSource } from "../data-source/branches-data-source";

export const SERVED_STATUS_ORDERING_RETRY_CACHE_TTL_MS = 5000;
export const SERVED_STATUS_ORDERING_CACHE_MAX_ENTRIES = 32;
export const SERVED_STATUS_ORDERING_RENEW_MS = 4 * 60 * 1000;

type ServedStatusOrderingState =
  | {
      status: "idle";
      key: string | null;
      statusOrdering: null;
    }
  | {
      status: "pending";
      key: string;
      statusOrdering: null;
    }
  | {
      status: "ready";
      key: string;
      /**
       * ISS-9437 — the status ordering the producer says it built this scope's
       * pages with, LATCHED. `null` means it has not stated one: a producer that
       * predates the field, or a read that did not answer at all.
       *
       * A NON-ANSWER HOLDS the previously latched value rather than falling back
       * to a default. `evaluateFeatureFlagForAnyIdentity` reports UNAVAILABLE
       * distinctly from an evaluated `false` precisely so a memoizing caller can
       * hold; flapping the ordering here would re-key the list query and yank
       * the reader back to page 0 every time PostHog blinked.
       */
      statusOrdering: string | null;
      /**
       * Whether the producer ANSWERED, independent of whether it named an
       * ordering. A producer that states none is a successful read and renews on
       * the normal boundary; only a null/failed read takes the short retry.
       */
      answered: boolean;
      refreshedAt: number;
    };

type CachedServedStatusOrdering = {
  promise: Promise<ServedStatusOrderingRead>;
  reusableResponse: ServedStatusOrderingRead | null;
  settledAt: number | null;
};

type ServedStatusOrderingRead = {
  response: BranchListStatusOrderingResponse | null;
  refreshedAt: number;
};

type ServedStatusOrderingReadOptions = {
  forceRefresh?: boolean;
};

const servedStatusOrderingCache = new Map<string, CachedServedStatusOrdering>();

/**
 * Reads and renews the ordering the producer says it is serving for one logical
 * Branches scope. Successful reads are reusable only until the renewal
 * boundary, while null/error reads keep the short retry cache so a transient
 * failure is not pinned.
 */
export function useServedStatusOrdering(
  dataSource: BranchesDataSource | null,
  key: string
): ServedStatusOrderingState {
  const reusableOrdering = dataSource?.listStatusOrdering
    ? reusableServedStatusOrderingState(key, Date.now())
    : null;
  const [ordering, setOrdering] = useState<ServedStatusOrderingState>({
    status: "idle",
    key: null,
    statusOrdering: null,
  });
  useEffect(() => {
    if (!dataSource?.listStatusOrdering) {
      setOrdering({ status: "idle", key: null, statusOrdering: null });
      return;
    }
    const reusable = reusableServedStatusOrderingState(key, Date.now());
    if (reusable) {
      setOrdering((current) => adoptServedOrdering(current, reusable));
      return;
    }
    let canceled = false;
    setOrdering((current) =>
      current.status === "ready" && current.key === key
        ? current
        : { status: "pending", key, statusOrdering: null }
    );
    readServedStatusOrdering(dataSource, key).then(
      (read) => {
        if (canceled) {
          return;
        }
        setOrdering((current) => readyOrderingState(current, key, read));
      },
      () => {
        if (!canceled) {
          setOrdering((current) => readyOrderingState(current, key, null));
        }
      }
    );
    return () => {
      canceled = true;
    };
  }, [dataSource, key]);
  useEffect(() => {
    if (
      !dataSource?.listStatusOrdering ||
      ordering.status !== "ready" ||
      ordering.key !== key
    ) {
      return;
    }
    const refreshAfterMs = ordering.answered
      ? SERVED_STATUS_ORDERING_RENEW_MS
      : SERVED_STATUS_ORDERING_RETRY_CACHE_TTL_MS;
    const delay = Math.max(
      0,
      refreshAfterMs - (Date.now() - ordering.refreshedAt)
    );
    let canceled = false;
    const timeout = setTimeout(() => {
      readServedStatusOrdering(dataSource, key, { forceRefresh: true }).then(
        (read) => {
          if (canceled) {
            return;
          }
          setOrdering((current) => readyOrderingState(current, key, read));
        },
        () => {
          if (!canceled) {
            setOrdering((current) => readyOrderingState(current, key, null));
          }
        }
      );
    }, delay);
    return () => {
      canceled = true;
      clearTimeout(timeout);
    };
  }, [ordering, dataSource, key]);
  return ordering.key === key
    ? ordering
    : (reusableOrdering ?? {
        status: "pending",
        key,
        statusOrdering: null,
      });
}

function readServedStatusOrdering(
  dataSource: BranchesDataSource,
  key: string,
  options: ServedStatusOrderingReadOptions = {}
): Promise<ServedStatusOrderingRead> {
  const now = Date.now();
  pruneServedStatusOrderingCache(now);
  const cached = servedStatusOrderingCache.get(key);
  if (cached) {
    if (cached.settledAt === null) {
      return cached.promise;
    }
    const ageMs = now - cached.settledAt;
    const reusable = reusableServedStatusOrderingRead(cached, now);
    if (!options.forceRefresh && reusable) {
      return Promise.resolve(reusable);
    }
    if (
      !options.forceRefresh &&
      cached.reusableResponse === null &&
      ageMs <= SERVED_STATUS_ORDERING_RETRY_CACHE_TTL_MS
    ) {
      return cached.promise;
    }
  }

  const entry: CachedServedStatusOrdering = {
    promise: (dataSource.listStatusOrdering?.() ?? Promise.resolve(null)).then(
      (response) => ({ response, refreshedAt: Date.now() })
    ),
    reusableResponse: null,
    settledAt: null,
  };
  entry.promise.then(
    (read) => {
      entry.reusableResponse = read.response ? read : null;
      entry.settledAt = read.refreshedAt;
    },
    () => {
      entry.reusableResponse = null;
      entry.settledAt = Date.now();
    }
  );
  servedStatusOrderingCache.set(key, entry);
  evictOldestServedStatusOrderingEntries();
  return entry.promise;
}

function reusableServedStatusOrderingState(
  key: string,
  now: number
): ServedStatusOrderingState | null {
  const cached = servedStatusOrderingCache.get(key);
  if (!cached) {
    return null;
  }
  const reusable = reusableServedStatusOrderingRead(cached, now);
  return reusable
    ? {
        status: "ready",
        key,
        statusOrdering: servedStatusOrdering(reusable),
        answered: true,
        refreshedAt: reusable.refreshedAt,
      }
    : null;
}

function reusableServedStatusOrderingRead(
  cached: CachedServedStatusOrdering,
  now: number
): ServedStatusOrderingRead | null {
  if (cached.settledAt === null || !cached.reusableResponse) {
    return null;
  }
  return now - cached.settledAt < SERVED_STATUS_ORDERING_RENEW_MS
    ? cached.reusableResponse
    : null;
}

function pruneServedStatusOrderingCache(now: number): void {
  for (const [key, entry] of servedStatusOrderingCache) {
    const ttlMs = entry.reusableResponse
      ? SERVED_STATUS_ORDERING_RENEW_MS
      : SERVED_STATUS_ORDERING_RETRY_CACHE_TTL_MS;
    if (entry.settledAt !== null && now - entry.settledAt > ttlMs) {
      servedStatusOrderingCache.delete(key);
    }
  }
}

function evictOldestServedStatusOrderingEntries(): void {
  while (
    servedStatusOrderingCache.size > SERVED_STATUS_ORDERING_CACHE_MAX_ENTRIES
  ) {
    const oldestKey = servedStatusOrderingCache.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }
    servedStatusOrderingCache.delete(oldestKey);
  }
}

/**
 * The ready state for a settled read, latching the served status ordering.
 *
 * ISS-9437 — an ABSENT ordering HOLDS whatever this scope had already latched,
 * and `read === null` (a rejected read) is the same case. Absent has exactly two
 * causes and both want the same answer: a producer that predates the field, and
 * a producer whose own flag evaluation came back UNAVAILABLE and therefore
 * declined to state one. Falling back to a default for either would re-key the
 * reader's list query and reset their page on a transient blip.
 *
 * The hold is scoped to the SAME key: a different scope has not latched
 * anything, so it starts absent rather than inheriting another scope's answer.
 */
function readyOrderingState(
  current: ServedStatusOrderingState,
  key: string,
  read: ServedStatusOrderingRead | null
): ServedStatusOrderingState {
  const held =
    current.status === "ready" && current.key === key
      ? current.statusOrdering
      : null;
  return {
    status: "ready",
    key,
    statusOrdering: read ? (servedStatusOrdering(read) ?? held) : held,
    answered: Boolean(read?.response),
    refreshedAt: read?.refreshedAt ?? Date.now(),
  };
}

/** Adopt a cache-reused read without dropping an ordering already latched. */
function adoptServedOrdering(
  current: ServedStatusOrderingState,
  reusable: ServedStatusOrderingState
): ServedStatusOrderingState {
  if (
    reusable.status !== "ready" ||
    reusable.statusOrdering !== null ||
    current.status !== "ready" ||
    current.key !== reusable.key
  ) {
    return reusable;
  }
  return { ...reusable, statusOrdering: current.statusOrdering };
}

function servedStatusOrdering(read: ServedStatusOrderingRead): string | null {
  return read.response?.statusOrdering ?? null;
}
