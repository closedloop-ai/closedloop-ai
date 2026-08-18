/**
 * @file claude-code-analytics-service.ts
 * @description Desktop-main (ESM) seam between the read-only Claude Code Analytics
 * client (`claude-code-analytics-client.ts`) and the live app (FEA-1436). app.ts
 * instantiates one of these and exposes a thin IPC handler that delegates to
 * `fetchAnalytics()`, which the renderer's Cost tab calls to show per-user Claude
 * Code spend (Anthropic's OWN estimate).
 *
 * ── Why this is separate from CostReconciliationService ──────────────────────
 * Reconciliation compares the local genai-prices estimate against what a vendor
 * actually BILLED (drift). This analytics view is a different concern: it surfaces
 * Anthropic's own per-user usage estimate and never feeds the reconciliation math
 * or the local ledger. Keeping it in its own service means analytics availability
 * is independent of reconciliation, and each service has a single responsibility.
 *
 * ── Security posture ─────────────────────────────────────────────────────────
 * Lives entirely in desktop-main and depends on the Anthropic Admin key store
 * through a deliberately minimal reader interface (getKey/getStatus only — ISP):
 * it reads the key ONLY to construct the outbound client (which places it in
 * request headers), never logs it, and never returns it over IPC. The per-user
 * data it returns (emails) is org billing data that crosses IPC to the trusted
 * host renderer only.
 */
import type { AdminKeyStatus } from "./admin-key-store.js";
import {
  ClaudeCodeAnalyticsClient,
  type ClaudeCodeUsageRecord,
} from "./claude-code-analytics-client.js";

/** Minimal Anthropic key reader (ISP): analytics only reads the key + status. */
export type AnthropicKeyReader = {
  getKey(): string | null;
  getStatus(): AdminKeyStatus;
};

/** The analytics client surface (a structural subset of ClaudeCodeAnalyticsClient). */
export type ClaudeCodeAnalyticsClientLike = {
  fetchUsage(query: {
    startDay: string;
    endDay: string;
  }): Promise<ClaudeCodeUsageRecord[]>;
};

/** Default trailing window (inclusive days) when the caller doesn't specify one. */
export const DEFAULT_ANALYTICS_WINDOW_DAYS = 7;
/** Hard cap on the requested window (matches the client's day-loop cap). */
export const MAX_ANALYTICS_WINDOW_DAYS = 92;

/** Outcome of an analytics fetch (safe to return over IPC — no key material). */
export type ClaudeCodeAnalyticsResult = {
  /** True when an Anthropic Admin key is configured (a fetch was attempted). */
  available: boolean;
  /** Normalized usage records (empty when unavailable, errored, or no usage). */
  records: ClaudeCodeUsageRecord[];
  /** The UTC day window actually queried, or null when no fetch ran. */
  window: { startDay: string; endDay: string } | null;
  /** Key-free error message if the fetch failed, else null. */
  error: string | null;
  /** ISO timestamp when this result was computed, or null when no fetch ran. */
  computedAt: string | null;
};

/** Renderer-supplied query options (validated/clamped here — untrusted input). */
export type ClaudeCodeAnalyticsQueryInput = {
  /** Trailing days to fetch (inclusive of today). Clamped to [1, MAX]. */
  windowDays?: number;
};

export type ClaudeCodeAnalyticsServiceDeps = {
  anthropicKeyStore: AnthropicKeyReader;
  /** Build the analytics client from a key (overridable in tests). */
  createClient?: (apiKey: string) => ClaudeCodeAnalyticsClientLike;
  /** Injectable clock (tests pin it; defines "today" and computedAt). */
  now?: () => Date;
  /** Key-free diagnostic log sink (app.ts passes the gateway logger). */
  log?: (message: string) => void;
};

/** Default production factory: the real read-only Claude Code Analytics client. */
function defaultCreateClient(apiKey: string): ClaudeCodeAnalyticsClientLike {
  return new ClaudeCodeAnalyticsClient({ apiKey });
}

/** Extract a safe, key-free message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === "string" ? err : "unknown error";
}

/** UTC `YYYY-MM-DD` for a Date. */
function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Clamp a renderer-supplied window to a sane integer in [1, MAX]. */
function clampWindowDays(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_ANALYTICS_WINDOW_DAYS;
  }
  const days = Math.trunc(value);
  if (days < 1) {
    return 1;
  }
  if (days > MAX_ANALYTICS_WINDOW_DAYS) {
    return MAX_ANALYTICS_WINDOW_DAYS;
  }
  return days;
}

export class ClaudeCodeAnalyticsService {
  private readonly keyStore: AnthropicKeyReader;
  private readonly createClient: (
    apiKey: string
  ) => ClaudeCodeAnalyticsClientLike;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(deps: ClaudeCodeAnalyticsServiceDeps) {
    this.keyStore = deps.anthropicKeyStore;
    this.createClient = deps.createClient ?? defaultCreateClient;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
  }

  /** Existence-only Anthropic Admin key status (safe to return over IPC). */
  getKeyStatus(): AdminKeyStatus {
    return this.keyStore.getStatus();
  }

  /**
   * Fetch Anthropic's Claude Code usage estimate for the trailing window. Returns
   * `available: false` when no Admin key is configured (no fetch attempted), and
   * surfaces a fetch failure (bad key, 403 on a non-Team/Enterprise org, network)
   * as a key-free `error` with empty records rather than throwing.
   */
  async fetchAnalytics(
    input?: ClaudeCodeAnalyticsQueryInput
  ): Promise<ClaudeCodeAnalyticsResult> {
    if (!this.keyStore.getStatus().hasKey) {
      return {
        available: false,
        records: [],
        window: null,
        error: null,
        computedAt: null,
      };
    }
    const apiKey = this.keyStore.getKey();
    if (!apiKey) {
      // Cleared between the has-key check and use; treat as unavailable.
      return {
        available: false,
        records: [],
        window: null,
        error: null,
        computedAt: null,
      };
    }

    const windowDays = clampWindowDays(input?.windowDays);
    const today = this.now();
    const endDay = utcDay(today);
    const startDay = utcDay(
      new Date(today.getTime() - (windowDays - 1) * 86_400_000)
    );
    const window = { startDay, endDay };

    try {
      const client = this.createClient(apiKey);
      const records = await client.fetchUsage(window);
      return {
        available: true,
        records,
        window,
        error: null,
        computedAt: this.now().toISOString(),
      };
    } catch (err) {
      const message = errorMessage(err);
      this.log(`claude code analytics fetch failed: ${message}`);
      return {
        available: true,
        records: [],
        window,
        error: message,
        computedAt: this.now().toISOString(),
      };
    }
  }
}
