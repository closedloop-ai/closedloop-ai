import { log } from "@repo/observability/log";
import { errorCode } from "../storage/error-code";

export const DocSyncDependency = { Database: "database" } as const;

export const DOC_SYNC_DEPENDENCY_LOST_EVENT = "doc_sync.dependency_lost";
export const DOC_SYNC_DEPENDENCY_RESTORED_EVENT =
  "doc_sync.dependency_restored";

export const HEALTH_PROBE_TIMEOUT_MS = 2000;
export const HEALTH_PROBE_CACHE_MS = 1000;

export type HealthVerdict = { ok: boolean };
export type HealthProbe = { check: () => Promise<HealthVerdict> };

/**
 * Whether the document database answers: `ping` raced against `timeoutMs`.
 * A verdict is reused for `cacheMs`, and concurrent checks share one
 * attempt. A ping still pending at `timeoutMs` fails that check but is not
 * replaced: later checks race the same ping until it settles, so at most one
 * ping is ever outstanding. The first failure
 * (at start, or after a success) logs {@link DOC_SYNC_DEPENDENCY_LOST_EVENT};
 * the first success after a failure logs
 * {@link DOC_SYNC_DEPENDENCY_RESTORED_EVENT}.
 */
export function createHealthProbe({
  ping,
  timeoutMs = HEALTH_PROBE_TIMEOUT_MS,
  cacheMs = HEALTH_PROBE_CACHE_MS,
  now = Date.now,
}: {
  ping: () => Promise<void>;
  timeoutMs?: number;
  cacheMs?: number;
  now?: () => number;
}): HealthProbe {
  let cached: { verdict: HealthVerdict; at: number } | undefined;
  let inFlight: Promise<HealthVerdict> | undefined;
  let lastOk: boolean | undefined;
  let pendingPing: Promise<string | undefined> | undefined;

  const pingOnce = (): Promise<string | undefined> => {
    pendingPing ??= new Promise<void>((resolve) => resolve(ping()))
      .then(
        () => undefined,
        (error: unknown) => errorCode(error)
      )
      .finally(() => {
        pendingPing = undefined;
      });
    return pendingPing;
  };

  const record = (failureCode: string | undefined): HealthVerdict => {
    const ok = failureCode === undefined;
    if (!ok && lastOk !== false) {
      log.error("Doc sync dependency lost", {
        event: DOC_SYNC_DEPENDENCY_LOST_EVENT,
        dependency: DocSyncDependency.Database,
        code: failureCode,
      });
    }
    if (ok && lastOk === false) {
      log.info("Doc sync dependency restored", {
        event: DOC_SYNC_DEPENDENCY_RESTORED_EVENT,
        dependency: DocSyncDependency.Database,
      });
    }
    lastOk = ok;
    return { ok };
  };

  const attempt = async (): Promise<HealthVerdict> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT_CODE), timeoutMs);
    });
    try {
      return record(await Promise.race([pingOnce(), timedOut]));
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    check: () => {
      if (cached && now() - cached.at < cacheMs) {
        return Promise.resolve(cached.verdict);
      }
      inFlight ??= attempt().then((verdict) => {
        cached = { verdict, at: now() };
        inFlight = undefined;
        return verdict;
      });
      return inFlight;
    },
  };
}

const TIMEOUT_CODE = "timeout";
