/**
 * @file cost-reconciliation-service.ts
 * @description Desktop-main (ESM) production wiring for nightly cost
 * reconciliation (FEA-1435/1436). It is the seam between the pure worker
 * (`reconciliation-worker.ts`) and the live app: it owns the two vendor Admin
 * key stores and the reconciliation store, builds the vendor cost clients from
 * the stored Admin keys, runs the worker, and schedules it nightly. app.ts
 * instantiates one of these and exposes thin IPC handlers that delegate to it.
 *
 * ── Security posture ─────────────────────────────────────────────────────────
 * Lives entirely in desktop-main. The Admin keys are read via `getKey()` ONLY to
 * construct the outbound vendor clients (which place the key in request headers);
 * they are never logged, never returned over IPC, and never handed to the
 * sidecar. The only key-related shape that leaves this service is the
 * existence-only `AdminKeyStatus` from `getStatus()`.
 *
 * ── Why each vendor is reconciled in its own pass ────────────────────────────
 * The worker treats a vendor with no fetch function as "not queried" and skips
 * it. We run one worker pass PER vendor that has a key, each wired with only that
 * vendor's fetch function, so a failure or auth error from one vendor (bad key,
 * 401/403, network) is isolated: it is recorded as that vendor's run error and
 * never corrupts or aborts the other vendor's reconciliation, and a failed fetch
 * never degrades to a fabricated `$0` bill (which would manufacture false drift).
 *
 * This module imports the Admin key store and reconciliation store as TYPES only
 * (the concrete classes pull in electron-store / safeStorage), so the engine is
 * unit-testable under the Node/tsx test runner with injected fakes and no
 * Electron, mirroring the worker's own injectable design.
 */

import type { VendorBilledEntry } from "./admin-billing.js";
import type { AdminKeyStatus, AdminKeyVendor } from "./admin-key-store.js";
import { AnthropicAdminClient } from "./anthropic-admin-client.js";
import { OpenAiAdminClient } from "./openai-admin-client.js";
import type {
  ReconciliationQuery,
  ReconciliationRow,
  ReconciliationStore,
} from "./reconciliation-store.js";
import {
  type DriftNotice,
  type MeteredUsageRow,
  type ReconciliationResult,
  runReconciliation,
} from "./reconciliation-worker.js";

/** How long after `start()` the first reconciliation runs (let the app settle). */
export const INITIAL_RECONCILIATION_DELAY_MS = 5 * 60 * 1000;

/** Cadence of the scheduled (nightly) reconciliation. */
export const RECONCILIATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The minimal Admin key store surface this service depends on (test-fakeable). */
export type AdminKeyStoreLike = {
  getKey(): string | null;
  getStatus(): AdminKeyStatus;
  setKey(key: string): void;
  clearKey(): void;
};

/** The Anthropic cost client surface (a structural subset of AnthropicAdminClient). */
export type AnthropicCostClient = {
  fetchCostReport(query: {
    startingAt: string;
    endingAt: string;
  }): Promise<VendorBilledEntry[]>;
};

/** The OpenAI cost client surface (a structural subset of OpenAiAdminClient). */
export type OpenAiCostClient = {
  fetchCosts(query: {
    startTime: number;
    endTime: number;
  }): Promise<VendorBilledEntry[]>;
};

/** Existence-only statuses for both vendors — the only key shape that crosses IPC. */
export type AdminKeyStatuses = {
  anthropic: AdminKeyStatus;
  openai: AdminKeyStatus;
};

/** One vendor's run failure, surfaced to the UI (message is key-free by construction). */
export type VendorRunError = {
  vendor: AdminKeyVendor;
  message: string;
};

/** Outcome of one reconciliation run (manual or scheduled). */
export type ReconciliationRunSummary = {
  /** Vendors whose pass completed without throwing. */
  vendorsReconciled: AdminKeyVendor[];
  /**
   * Vendors whose billing API was ACTUALLY called this run. A vendor in
   * `vendorsReconciled` but NOT here completed without error yet made no vendor
   * request (no local usage window to reconcile against), so its Admin key was
   * never contacted. The UI uses this to avoid claiming a key was "verified"
   * when no vendor request occurred (e.g. on a fresh install with no metered
   * sessions yet).
   */
  vendorsQueried: AdminKeyVendor[];
  /** Total reconciliation rows persisted across all vendor passes. */
  rowsWritten: number;
  /** Drift notices (over threshold) across all vendor passes. */
  notices: DriftNotice[];
  /** Per-vendor failures (auth/network); other vendors still reconcile. */
  errors: VendorRunError[];
  /** When the run computed its rows, or null if nothing ran (no keys / busy). */
  computedAt: string | null;
  /** True when a run was already in progress and this call was a no-op. */
  skippedBusy: boolean;
};

export type CostReconciliationServiceDeps = {
  anthropicKeyStore: AdminKeyStoreLike;
  openaiKeyStore: AdminKeyStoreLike;
  store: Pick<ReconciliationStore, "upsert" | "list">;
  /** Load the metered usage rows to reconcile. */
  loadUsageRows: () => MeteredUsageRow[] | Promise<MeteredUsageRow[]>;
  /** Build the Anthropic cost client from a key (overridable in tests). */
  createAnthropicClient?: (apiKey: string) => AnthropicCostClient;
  /** Build the OpenAI cost client from a key (overridable in tests). */
  createOpenAiClient?: (apiKey: string) => OpenAiCostClient;
  /** Injectable clock (tests pin it; flows into row computedAt timestamps). */
  now?: () => Date;
  /** Key-free diagnostic log sink (app.ts passes the gateway logger). */
  log?: (message: string) => void;
  /** Injectable timer seams so scheduling is testable without real time. */
  setInterval?: (
    handler: () => void,
    ms: number
  ) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
  setTimeout?: (
    handler: () => void,
    ms: number
  ) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
};

const ALL_VENDORS: readonly AdminKeyVendor[] = ["anthropic", "openai"];

/** Default production factory: the real Anthropic Admin Cost Report client. */
function defaultCreateAnthropicClient(apiKey: string): AnthropicCostClient {
  return new AnthropicAdminClient({ apiKey });
}

/** Default production factory: the real OpenAI organization Costs client. */
function defaultCreateOpenAiClient(apiKey: string): OpenAiCostClient {
  return new OpenAiAdminClient({ apiKey });
}

/** Extract a safe, key-free message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === "string" ? err : "unknown error";
}

export class CostReconciliationService {
  private readonly deps: CostReconciliationServiceDeps;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private readonly createAnthropicClient: (
    apiKey: string
  ) => AnthropicCostClient;
  private readonly createOpenAiClient: (apiKey: string) => OpenAiCostClient;
  private readonly setIntervalFn: NonNullable<
    CostReconciliationServiceDeps["setInterval"]
  >;
  private readonly clearIntervalFn: NonNullable<
    CostReconciliationServiceDeps["clearInterval"]
  >;
  private readonly setTimeoutFn: NonNullable<
    CostReconciliationServiceDeps["setTimeout"]
  >;
  private readonly clearTimeoutFn: NonNullable<
    CostReconciliationServiceDeps["clearTimeout"]
  >;

  private running = false;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private initialHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: CostReconciliationServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
    this.createAnthropicClient =
      deps.createAnthropicClient ?? defaultCreateAnthropicClient;
    this.createOpenAiClient =
      deps.createOpenAiClient ?? defaultCreateOpenAiClient;
    this.setIntervalFn = deps.setInterval ?? ((h, ms) => setInterval(h, ms));
    this.clearIntervalFn = deps.clearInterval ?? ((h) => clearInterval(h));
    this.setTimeoutFn = deps.setTimeout ?? ((h, ms) => setTimeout(h, ms));
    this.clearTimeoutFn = deps.clearTimeout ?? ((h) => clearTimeout(h));
  }

  /** Existence-only key statuses for both vendors (safe to return over IPC). */
  getAdminKeyStatuses(): AdminKeyStatuses {
    return {
      anthropic: this.deps.anthropicKeyStore.getStatus(),
      openai: this.deps.openaiKeyStore.getStatus(),
    };
  }

  /** Persist a vendor Admin key (throws on empty key / unavailable safeStorage). */
  setAdminKey(vendor: AdminKeyVendor, key: string): AdminKeyStatuses {
    this.storeFor(vendor).setKey(key);
    return this.getAdminKeyStatuses();
  }

  /** Remove a vendor Admin key. */
  clearAdminKey(vendor: AdminKeyVendor): AdminKeyStatuses {
    this.storeFor(vendor).clearKey();
    return this.getAdminKeyStatuses();
  }

  /** Query persisted reconciliation rows for the diagnostics view. */
  listRows(query?: ReconciliationQuery): ReconciliationRow[] {
    return this.deps.store.list(query);
  }

  /**
   * Run a reconciliation pass now. Serialized: if one is already running this is
   * a no-op (`skippedBusy: true`) so a manual run cannot race the scheduled one.
   */
  async runReconciliationNow(): Promise<ReconciliationRunSummary> {
    if (this.running) {
      return {
        vendorsReconciled: [],
        vendorsQueried: [],
        rowsWritten: 0,
        notices: [],
        errors: [],
        computedAt: null,
        skippedBusy: true,
      };
    }
    this.running = true;
    try {
      return await this.runInternal();
    } finally {
      this.running = false;
    }
  }

  /** Begin the scheduled cadence: an initial delayed run, then nightly. */
  start(): void {
    if (this.intervalHandle || this.initialHandle) {
      return;
    }
    this.initialHandle = this.setTimeoutFn(() => {
      this.initialHandle = null;
      void this.runScheduled();
    }, INITIAL_RECONCILIATION_DELAY_MS);
    this.intervalHandle = this.setIntervalFn(() => {
      void this.runScheduled();
    }, RECONCILIATION_INTERVAL_MS);
  }

  /** Stop the scheduled cadence (idempotent). */
  stop(): void {
    if (this.intervalHandle) {
      this.clearIntervalFn(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.initialHandle) {
      this.clearTimeoutFn(this.initialHandle);
      this.initialHandle = null;
    }
  }

  /** A scheduled tick: skip quietly when no keys are configured. */
  private async runScheduled(): Promise<void> {
    if (this.vendorsWithKeys().length === 0) {
      return;
    }
    const summary = await this.runReconciliationNow();
    if (summary.notices.length > 0) {
      this.log(
        `cost reconciliation: ${summary.notices.length} drift notice(s) over threshold`
      );
    }
    for (const error of summary.errors) {
      this.log(`cost reconciliation error (${error.vendor}): ${error.message}`);
    }
  }

  private async runInternal(): Promise<ReconciliationRunSummary> {
    const vendors = this.vendorsWithKeys();
    if (vendors.length === 0) {
      return {
        vendorsReconciled: [],
        vendorsQueried: [],
        rowsWritten: 0,
        notices: [],
        errors: [],
        computedAt: null,
        skippedBusy: false,
      };
    }

    // Load usage once and reuse it across each vendor's pass.
    const usageRows = await this.deps.loadUsageRows();
    const loadUsageRows = (): MeteredUsageRow[] => usageRows;

    let rowsWritten = 0;
    const notices: DriftNotice[] = [];
    const errors: VendorRunError[] = [];
    const vendorsReconciled: AdminKeyVendor[] = [];
    const vendorsQueried: AdminKeyVendor[] = [];

    for (const vendor of vendors) {
      try {
        const result = await this.reconcileVendor(vendor, loadUsageRows);
        rowsWritten += result.rowsWritten;
        notices.push(...result.notices);
        vendorsReconciled.push(vendor);
        // The vendor's API was only contacted if the pass had a usage window.
        if (result.queriedVendors.includes(vendor)) {
          vendorsQueried.push(vendor);
        }
      } catch (err) {
        errors.push({ vendor, message: errorMessage(err) });
        this.log(
          `cost reconciliation failed for ${vendor}: ${errorMessage(err)}`
        );
      }
    }

    return {
      vendorsReconciled,
      vendorsQueried,
      rowsWritten,
      notices,
      errors,
      computedAt: this.now().toISOString(),
      skippedBusy: false,
    };
  }

  /** Reconcile a single vendor with only that vendor's fetch function wired in. */
  private async reconcileVendor(
    vendor: AdminKeyVendor,
    loadUsageRows: () => MeteredUsageRow[]
  ): Promise<ReconciliationResult> {
    const apiKey = this.storeFor(vendor).getKey();
    if (!apiKey) {
      // Cleared between the has-key check and use; nothing to reconcile.
      return { rowsWritten: 0, notices: [], queriedVendors: [] };
    }
    if (vendor === "anthropic") {
      const client = this.createAnthropicClient(apiKey);
      return runReconciliation({
        loadUsageRows,
        fetchAnthropicBilled: (query) => client.fetchCostReport(query),
        store: this.deps.store,
        now: this.now,
      });
    }
    const client = this.createOpenAiClient(apiKey);
    return runReconciliation({
      loadUsageRows,
      fetchOpenAiBilled: (query) => client.fetchCosts(query),
      store: this.deps.store,
      now: this.now,
    });
  }

  /** The subset of vendors that currently have an Admin key configured. */
  private vendorsWithKeys(): AdminKeyVendor[] {
    return ALL_VENDORS.filter(
      (vendor) => this.storeFor(vendor).getKey() !== null
    );
  }

  private storeFor(vendor: AdminKeyVendor): AdminKeyStoreLike {
    return vendor === "anthropic"
      ? this.deps.anthropicKeyStore
      : this.deps.openaiKeyStore;
  }
}
