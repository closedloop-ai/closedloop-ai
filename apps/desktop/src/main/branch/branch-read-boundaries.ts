import { performance } from "node:perf_hooks";
import { isDbHostShutdownError } from "../../shared/db-host-shutdown-error.js";
import {
  SHARED_BRANCHES_SOURCE_ERROR_CODE,
  SHARED_BRANCHES_TRANSIENT_ERROR_CODE,
} from "../../shared/shared-branches-contract.js";
import { isTransientDbHostError } from "../../shared/transient-db-host-error.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import { writePersistentLog } from "../logging/persistent-log.js";

/** Sanitize a local data-source failure while retaining its retry classification. */
export function rethrowAsBranchSourceError(
  label: string,
  error: unknown
): never {
  writePersistentLog(
    "error",
    "branch-source-error",
    `${label}: ${String(error)}`
  );
  // ISS-5262 (closedloop-ai-stage review): the shutdown classification must
  // survive this boundary, not die at it. Every Branches handler is wrapped in
  // `withDb`, whose catch asks `isDbHostShutdownError` whether to resolve the
  // payload-free shutdown sentinel instead of rejecting — but that catch runs
  // OUTSIDE this function, so laundering a `DbHostShutdownError` into a bare
  // `Error(code)` here made the answer permanently `false`. Every Branches read
  // in flight at quit therefore still rejected, and `ipcMain.handle` logged
  // `Error occurred in handler for 'desktop:shared-branches:*'` after
  // `shutdown sequence end: clean` — precisely the contradiction this ticket
  // removes on the other channels.
  //
  // Rethrowing the ORIGINAL error is not a leak: `withDb` converts it to the
  // payload-free sentinel, and the preload turns that into the fixed
  // `DB_HOST_SHUTTING_DOWN_MESSAGE`, so no raw message reaches the renderer.
  // The renderer's classification is unchanged either way — that message leads
  // with `db-host is closed`, a `TRANSIENT_DB_HOST_ERROR_SIGNATURE`, so
  // `runSource` still produces a `TransientSourceError` carrying
  // `SHARED_BRANCHES_TRANSIENT_ERROR_CODE`, exactly as the sanitized code below
  // did. Same class, same code, quiet reconnecting state — no hard error card.
  if (isDbHostShutdownError(error)) {
    throw error;
  }
  // ISS-5808 — two corrections to what this boundary used to emit.
  //
  // 1. CLASSIFY ON THE TYPED ERROR. The message form alone answers "is this
  //    transient?" with a substring match on `db-host exited`, which
  //    `handleExit` mints whether or not a replacement fork was armed. So a
  //    db-host the supervisor was NOT recovering still read TRANSIENT, and the
  //    renderer sat in its quiet reconnecting state, retrying, forever.
  //    `isTransientDbHostError` prefers `DbHostExitError.restartScheduled` and
  //    falls back to the message signatures for everything else, so only the
  //    genuinely-unrecoverable exit moves — to the hard error card with Retry,
  //    which is the honest surface for it.
  //
  // 2. PRESERVE THE CAUSE. `new Error(code)` discarded the original outright, so
  //    one root cause presented as two unrelated errors: the Sessions channel
  //    logged `db-host exited (code: 0)` while this one logged a bare
  //    `LOCAL_BRANCHES_SOURCE_TRANSIENT`, and nobody diagnosing from the
  //    Branches side could reach db-host at all. `cause` is a main-process-only
  //    link — the preload sends the renderer the sanitized `code` and nothing
  //    else — so this leaks no local data while letting the outer `withDb`
  //    wrapper still recognize a re-drivable host exit through this boundary.
  const code = isTransientDbHostError(error)
    ? SHARED_BRANCHES_TRANSIENT_ERROR_CODE
    : SHARED_BRANCHES_SOURCE_ERROR_CODE;
  throw new Error(code, { cause: error });
}

/** Build the verbose-only per-stage timer for one Branch detail read. */
export function startBranchDetailPerf(id: string): {
  mark: (label: string, count?: number) => void;
  done: (outcome: string, counts?: Record<string, number>) => void;
} {
  const startedAt = performance.now();
  let previousStageAt = startedAt;
  const stages: string[] = [];
  return {
    mark(label, count) {
      const now = performance.now();
      const durationMs = (now - previousStageAt).toFixed(1);
      stages.push(
        count == null
          ? `${label}=${durationMs}ms`
          : `${label}=${durationMs}ms(${count})`
      );
      previousStageAt = now;
    },
    done(outcome, counts) {
      const totalMs = (performance.now() - startedAt).toFixed(1);
      gatewayLog.debug("branches-perf", () => {
        const tail = counts
          ? ` ${Object.entries(counts)
              .map(([key, value]) => `${key}=${value}`)
              .join(" ")}`
          : "";
        return `detail ${outcome} id=${id} total=${totalMs}ms ${stages.join(" ")}${tail}`;
      });
    },
  };
}
