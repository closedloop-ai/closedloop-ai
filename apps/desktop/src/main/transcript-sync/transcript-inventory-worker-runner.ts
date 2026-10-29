/**
 * @file transcript-inventory-worker-runner.ts
 * @description ISS-8376 — the main-thread driver for the one-shot transcript
 * byte-inventory worker.
 *
 * Deliberately smaller than the repo's other worker runners
 * (`agent-session-sync-payload-worker-runner.ts` and the three
 * `utility-process-*` runners): those keep a long-lived child and multiplex
 * requests by id, because they are called repeatedly. This sweep runs at most
 * once per process, so the child is forked, asked once, and terminated — there
 * is no in-flight map, no reuse and no request id to get wrong.
 *
 * NEVER REJECTS. Every failure — a worker that throws, dies, outruns the bound,
 * or replies with an inventory that cannot be believed — resolves `null`. The
 * caller's honest answer for "no measurement" is the `unavailable` inventory
 * variant, and a rejection here would only be converted into that same value
 * one frame later while giving every caller a chance to forget the catch.
 *
 * The last of those four is the only one that is OUR bug rather than the
 * machine's, so it alone is reported through `onMalformedReply`.
 */

import { Worker } from "node:worker_threads";
import { isTranscriptByteInventory } from "./transcript-byte-inventory-parse.js";
import type { TranscriptByteInventory } from "./transcript-byte-inventory-types.js";
import type { TranscriptInventoryWorkerRequest } from "./transcript-inventory-worker.js";

/**
 * How long the sweep may take before it is abandoned.
 *
 * Sized off the measured worst case, not guessed: 3,977 ms at the 100,000-entry
 * hard cap on a warm cache. 30s leaves room for a cold cache on slow media while
 * still being a bound rather than an open wait — a wedged sweep must not hold a
 * worker thread for the life of the app.
 */
export const TRANSCRIPT_INVENTORY_SWEEP_TIMEOUT_MS = 30_000;

export type TranscriptInventoryWorkerFork = () => Worker;

export type TranscriptInventorySweepOptions = {
  /** Injected so a test drives the settle paths without a real worker. */
  forkWorker?: TranscriptInventoryWorkerFork;
  /**
   * Called when a reply CLAIMED success and carried an inventory this build
   * cannot believe.
   *
   * Deliberately narrower than "the sweep failed". A timeout, a thrown sweep
   * (`ok: false`) or a dead worker are environmental conditions the
   * `unavailable` state already describes honestly. An `ok` reply carrying a
   * malformed inventory is a broken worker contract — our own bug — and because
   * the sweep is one-shot it silently costs onboarding its measurement for the
   * rest of the process. Root `AGENTS.md` (Handling Bad or Nonsensical Data):
   * route it to an existing monitor rather than coercing it away.
   */
  onMalformedReply?: () => void;
};

function forkInventoryWorker(): Worker {
  return new Worker(
    new URL("./transcript-inventory-worker.js", import.meta.url)
  );
}

/**
 * Run one sweep off-thread. Resolves the inventory, or `null` when it could not
 * be measured.
 */
export function runTranscriptInventorySweep(
  stateDir: string,
  options: TranscriptInventorySweepOptions = {}
): Promise<TranscriptByteInventory | null> {
  const forkWorker = options.forkWorker ?? forkInventoryWorker;
  return new Promise((resolve) => {
    let settled = false;
    let worker: Worker | null = null;
    let timer: NodeJS.Timeout | undefined;

    const settle = (inventory: TranscriptByteInventory | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      // Fire-and-forget: terminating an already-dead worker can reject, and a
      // discarded worker's teardown must never surface as an unhandled
      // rejection.
      worker?.terminate().catch(() => {
        // ignore: the worker is being discarded regardless of the outcome.
      });
      resolve(inventory);
    };

    try {
      worker = forkWorker();
    } catch {
      // The worker entry is missing from the build, or threads are unavailable.
      settle(null);
      return;
    }

    timer = setTimeout(
      () => settle(null),
      TRANSCRIPT_INVENTORY_SWEEP_TIMEOUT_MS
    );
    // Never hold the process open on the sweep's own bound.
    timer.unref?.();

    worker.on("message", (raw: unknown) => {
      // A reply queued behind the one that settled must not report again: the
      // malformed-reply callback feeds an uncapped emitter.
      if (settled) {
        return;
      }
      // The reply crosses a structured-clone boundary, so it is validated
      // rather than cast: an `ok` reply carrying a malformed inventory used to
      // be stored as a measurement and threw on the first read.
      const claimedSuccess =
        typeof raw === "object" &&
        raw !== null &&
        (raw as { ok?: unknown }).ok === true;
      if (!claimedSuccess) {
        settle(null);
        return;
      }
      const inventory = (raw as { inventory?: unknown }).inventory;
      if (isTranscriptByteInventory(inventory)) {
        settle(inventory);
        return;
      }
      options.onMalformedReply?.();
      settle(null);
    });
    worker.on("error", () => settle(null));
    worker.on("exit", () => settle(null));

    worker.postMessage({ stateDir } satisfies TranscriptInventoryWorkerRequest);
  });
}
