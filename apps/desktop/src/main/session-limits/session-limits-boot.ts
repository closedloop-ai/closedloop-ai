/**
 * @file session-limits-boot.ts
 * @description Owns the boot lifecycle of every session-limit PRODUCER, so
 * `app.ts` carries one object instead of one field, one start block, and one
 * shutdown line per producer.
 *
 * Extracted from `app.ts` when PRD-538 R5 added the third producer: `app.ts` is
 * on the `noExcessiveLinesPerFile` grandfather list (SHRINK-ONLY), and growing
 * it per producer is exactly the per-feature accretion the AGENTS.md
 * "File Size and Organization" rule exists to stop. The producers are a cohesive
 * unit — they all feed one store and are all gated on the same golden-mode
 * check — so they belong behind one seam.
 *
 * Producers started here:
 *  - `syncStatuslineCaptureOnBoot` (FEA-3492) — self-heals the opt-in statusLine
 *    capture entry after an app move/update;
 *  - the statusline reader (FEA-3523) — polls the snapshot file the hook writes;
 *  - the `/usage` capture service (PRD-538 R5) — the AUTHORITATIVE source, and
 *    the only one behind the `subscriptionSessionLimits` Labs gate.
 *
 * Every producer is best-effort: none may throw into boot, and none is a
 * prerequisite of another. Golden mode starts NOTHING — it must never write the
 * real `settings.json` (FEA-2648) nor read a real credential.
 *
 * ── Why the statusline half is loaded lazily ──────────────────────────────────
 * `statusline-capture-install` reaches into `electron` (app paths, electron-store)
 * at import time. Importing it at module scope here would drag Electron into
 * every consumer of this file — including the Node-only test runner, which
 * cannot load it. It is therefore pulled in with a dynamic import inside
 * `start()`, exactly as `session-limits-ipc.ts` does for the same module and the
 * same reason. The `/usage` producer has no such dependency and starts
 * synchronously, so a failure to load the statusline half can never delay or
 * suppress it.
 */
import {
  createStatuslineReader,
  type StatuslineReader,
} from "./statusline-reader.js";
import { createUsageApiService } from "./usage-api-runtime.js";
import type { UsageApiService } from "./usage-api-service.js";

/** The slice of `statusline-capture-install` this module needs. */
export type StatuslineCaptureModule = {
  statuslineSnapshotPath: () => string;
  syncStatuslineCaptureOnBoot: () => void;
};

export type SessionLimitsBootDeps = {
  /** Golden mode starts no producer at all. */
  isGoldenMode: () => boolean;
  /**
   * The `subscriptionSessionLimits` Labs gate (PRD-538, default off). Gates the
   * `/usage` producer ONLY: the statusline producer is a separate, already
   * shipped feature (FEA-3492/3523) and is not covered by this flag.
   */
  isUsageCaptureEnabled: () => boolean;
  /** Overridable for tests so no real file, Electron, or credential is touched. */
  loadStatuslineCaptureModule?: () => Promise<StatuslineCaptureModule>;
  createStatuslineReaderFn?: typeof createStatuslineReader;
  createUsageApiServiceFn?: typeof createUsageApiService;
};

/** Starts and stops the session-limit snapshot producers as one unit. */
export class SessionLimitsBoot {
  readonly #deps: SessionLimitsBootDeps;
  #statuslineReader: StatuslineReader | null = null;
  #usageApiService: UsageApiService | null = null;

  constructor(deps: SessionLimitsBootDeps) {
    this.#deps = deps;
  }

  /**
   * Start every producer. Idempotent. A failure in one producer never prevents
   * the others from starting and never propagates into boot.
   *
   * Returns a promise that settles once the lazily-loaded statusline half has
   * been attempted, so tests can await it; production callers may ignore it —
   * it never rejects.
   */
  start(): Promise<void> {
    if (this.#deps.isGoldenMode()) {
      return Promise.resolve();
    }
    this.#startUsageProducer();
    return this.#startStatuslineProducers();
  }

  /** Electron-free, synchronous, and gated by the Labs flag. */
  #startUsageProducer(): void {
    try {
      const makeUsage =
        this.#deps.createUsageApiServiceFn ?? createUsageApiService;
      // With the gate off this constructs a service that reads no credential
      // and schedules no timer — see usage-api-service.ts.
      this.#usageApiService ??= makeUsage({
        isEnabled: this.#deps.isUsageCaptureEnabled,
      });
      this.#usageApiService.start();
    } catch {
      // Capture stays unavailable; the surface hides rather than misreporting.
    }
  }

  /** Pulls in the Electron-dependent capture module, then starts the reader. */
  async #startStatuslineProducers(): Promise<void> {
    let mod: StatuslineCaptureModule;
    try {
      const load: () => Promise<StatuslineCaptureModule> =
        this.#deps.loadStatuslineCaptureModule ??
        (() => import("./statusline-capture-install.js"));
      mod = await load();
    } catch {
      // Statusline capture is unavailable; the `/usage` producer is unaffected.
      return;
    }
    try {
      mod.syncStatuslineCaptureOnBoot();
    } catch {
      // Self-heal is best-effort; capture simply stays as it was on disk.
    }
    try {
      const makeReader =
        this.#deps.createStatuslineReaderFn ?? createStatuslineReader;
      // Reads only a file the install hook writes; a missing/stale file is a
      // no-op, so this is safe even when the capture opt-in is off.
      this.#statuslineReader ??= makeReader({
        snapshotPath: mod.statuslineSnapshotPath,
      });
      this.#statuslineReader.start();
    } catch {
      // A dead reader must not affect anything else.
    }
  }

  /** Stop every producer and release their timers. Safe to call unstarted. */
  stop(): void {
    this.#statuslineReader?.stop();
    this.#usageApiService?.dispose();
  }
}
