/**
 * @file transcript-inventory-worker.ts
 * @description ISS-8376 — runs one transcript byte-inventory sweep off the
 * Electron main thread.
 *
 * WHY A WORKER. `collectTranscriptByteInventory` is synchronous by design and
 * fully dependency-injected; its own docstring says a caller that needs it off
 * the main thread "hosts this exact function in a worker without a line changing
 * here". ISS-8376 is that caller. Measured on the ticket's own benchmark, all
 * five capped listings at the cap: 638 ms at 10,000 files and 3,977 ms at the
 * 100,000-entry hard cap (the cap is per-lister and there are five listers).
 * Running that on main would block every IPC channel — including the 1s
 * runtime-status poll — at the exact moment the onboarding analysis screen
 * mounts.
 *
 * `worker_threads` rather than a `utilityProcess`: the sweep is pure `node:fs`
 * and needs nothing from Electron, and this is the lighter of the two patterns
 * already in main (`agent-session-sync-payload-worker.ts`).
 *
 * ONE REQUEST PER WORKER. The runner forks a worker, sends one request and
 * terminates it. There is no request multiplexing to get wrong because the sweep
 * is one-shot per process.
 */

import { parentPort } from "node:worker_threads";
import { collectTranscriptByteInventory } from "./transcript-byte-inventory.js";
import type { TranscriptByteInventory } from "./transcript-byte-inventory-types.js";

export type TranscriptInventoryWorkerRequest = {
  stateDir: string;
};

export type TranscriptInventoryWorkerResponse =
  | { ok: true; inventory: TranscriptByteInventory }
  | { ok: false; error: string };

parentPort?.on("message", (raw: unknown) => {
  const port = parentPort;
  if (!port) {
    return;
  }
  try {
    const request = raw as TranscriptInventoryWorkerRequest;
    // The sweep reaches the filesystem, so every failure mode it has — a
    // permission-blocked root, a vanished directory — arrives here as a throw.
    // Reporting it as a message rather than letting it become an uncaught
    // worker exception is what lets the runner degrade to `unavailable` instead
    // of the main process seeing an opaque worker death.
    const inventory = collectTranscriptByteInventory(request.stateDir);
    port.postMessage({
      ok: true,
      inventory,
    } satisfies TranscriptInventoryWorkerResponse);
  } catch (error) {
    port.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies TranscriptInventoryWorkerResponse);
  }
});
