/**
 * @file trace-comment-identity-resolver.ts
 * @description The cached API-key → user identity resolver for trace-comment
 * ownership checks, extracted out of the grandfathered `app.ts` (over the
 * 1,000-line ceiling) as a cohesive, directly unit-testable unit (PR #4098
 * review, wongk — the shrink-only rule for that file). `app.ts` keeps only a
 * single `TraceCommentIdentityResolver` field plus a thin delegate.
 *
 * Local-first: a cache miss returns `null` immediately and starts a bounded
 * background `/me` request, so a local comment mutation never blocks on cloud
 * auth. The cache is keyed by the sha256 fingerprint of the active API key PLUS
 * the API origin it was resolved against, so a key rotation OR an origin change
 * transparently invalidates it (ISS-6243 — onboarding commits the two in
 * separate steps, and the same key names different accounts on different
 * clouds). The class owns no Electron/app
 * imports — the key and API origin are supplied by accessors — so it stays a pure
 * unit the tests can drive without the desktop shell.
 */
import { createHash } from "node:crypto";
import { exponentialBackoffMs } from "../../shared/exponential-backoff.js";
import { unwrapApiResultData } from "../util/api-response-utils.js";
import { sameUserIdentity } from "../util/user-identity.js";

export type TraceCommentUserIdentity = {
  userId: string | null;
  organizationId: string | null;
};

export type TraceCommentIdentityResolverOptions = {
  /** The active API key, or `null`/`""` when unauthenticated. */
  getApiKey: () => string | null;
  /** The API origin the `/me` lookup is issued against. */
  getApiOrigin: () => string;
  /**
   * Override the HTTP client for the `/me` lookup, mirroring the seam
   * `DesktopSessionManager` already exposes. Undefined in production, where the
   * global `fetch` is used.
   */
  fetchImpl?: typeof fetch;
};

export class TraceCommentIdentityResolver {
  private cached: {
    credentialKey: string;
    userId: string;
    organizationId: string;
  } | null = null;
  private inFlightCredentialKey: string | null = null;
  /** ISS-6243 — handle of the pending bounded re-lookup, so it can be superseded. */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly options: TraceCommentIdentityResolverOptions;
  /**
   * ISS-6243 — subscribers to identity TRANSITIONS. This resolver is the only
   * thing in main that turns the active API key into a `(userId, organizationId)`
   * pair, so it is also the only place that can observe the pair changing: a
   * background `/me` landing after a cold start, a key rotation on an org
   * switch, a key removal on sign-out.
   */
  private readonly listeners = new Set<() => void>();
  /** The last identity the listeners were told about, so a transition fires once. */
  private notified: TraceCommentUserIdentity | null = null;

  constructor(options: TraceCommentIdentityResolverOptions) {
    this.options = options;
  }

  /**
   * ISS-6243 — observe identity transitions. The listener is called AFTER the
   * resolver has recorded the new value, so re-reading through {@link resolve}
   * from inside the listener returns the settled identity and cannot recurse.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Returns the cached API-key user identity for trace-comment ownership checks.
   * When unresolved, starts a bounded background `/me` request and returns null
   * so local-first comment mutations never wait on cloud auth.
   */
  resolve(): TraceCommentUserIdentity | null {
    const apiKey = this.options.getApiKey();
    if (!apiKey) {
      this.cached = null;
      this.inFlightCredentialKey = null;
      this.cancelRetry();
      this.notifyIfChanged(null);
      return null;
    }

    const credentialKey = this.credentialKey(apiKey);
    if (this.cached?.credentialKey === credentialKey) {
      const identity = {
        userId: this.cached.userId,
        organizationId: this.cached.organizationId,
      };
      this.notifyIfChanged(identity);
      return identity;
    }

    this.cached = null;
    this.warm(apiKey, credentialKey, 1);
    // ISS-6243: the key changed (or was never resolved), so the pair we last
    // published is no longer this account's. Announce the null BEFORE `/me`
    // lands — a stale identity would attribute new sessions to the previous
    // user, which is strictly worse than attributing them to nobody.
    this.notifyIfChanged(null);
    return null;
  }

  /**
   * ISS-6243 — fire the subscribers once per real transition of the resolved
   * pair. `notified` is updated BEFORE the listeners run, so a listener that
   * re-reads through `resolve()` observes the settled value and terminates
   * instead of re-entering this notification.
   *
   * Each listener is isolated for the same reason `ApiKeyStore` isolates its
   * own: `resolve()` is the local-first read that several unrelated lanes call
   * on their hot path, and it is documented never to block or throw on cloud
   * auth. A subscriber must not be able to break that for them.
   */
  private notifyIfChanged(identity: TraceCommentUserIdentity | null): void {
    if (sameUserIdentity(this.notified, identity)) {
      return;
    }
    this.notified = identity;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Best-effort fan-out: one bad subscriber must not strand the others,
        // nor surface as a failed identity read to an unrelated caller.
      }
    }
  }

  /**
   * ISS-6243 — the cache identity is the (key, API origin) PAIR, not the key
   * alone. The same key resolves to different accounts against different clouds,
   * and onboarding writes the key and the origin in two separate steps, so a
   * lookup can legitimately be issued against the previous origin. Keying on the
   * pair means such a result can never be served for the new origin: the next
   * read is a miss and re-resolves.
   */
  private credentialKey(apiKey: string): string {
    const fingerprint = createHash("sha256").update(apiKey).digest("hex");
    return `${fingerprint}@${this.options.getApiOrigin()}`;
  }

  private warm(apiKey: string, credentialKey: string, attempt: number): void {
    if (this.inFlightCredentialKey === credentialKey) {
      return;
    }
    this.inFlightCredentialKey = credentialKey;
    this.cancelRetry();
    this.fetchIdentity(apiKey)
      .then((outcome) => {
        if (this.inFlightCredentialKey !== credentialKey) {
          // A newer credential took over while this was in flight; its own
          // lookup owns the result and this one is discarded.
          return;
        }
        this.inFlightCredentialKey = null;
        if (outcome.identity) {
          this.cached = { credentialKey, ...outcome.identity };
          this.notifyIfChanged(outcome.identity);
          return;
        }
        if (outcome.retryable) {
          this.scheduleRetry(attempt + 1);
        }
      })
      .catch(() => {
        if (this.inFlightCredentialKey === credentialKey) {
          this.inFlightCredentialKey = null;
        }
      });
  }

  /**
   * ISS-6243 — re-lookup the ACTIVE credential after a transient `/me` failure.
   *
   * Without this, one flaky cold-start request left the resolver holding null
   * with nothing scheduled to try again: session ingestion reads the db host's
   * cached identity rather than calling `resolve()`, so nothing re-kicks it and
   * every session for the rest of the process is written unattributed.
   *
   * It re-derives the credential at fire time rather than replaying the one that
   * failed, so a retry that lands after onboarding commits the real API origin
   * targets the new origin instead of re-failing against the old one. Bounded by
   * {@link MAX_IDENTITY_LOOKUP_ATTEMPTS} and `unref`'d — an unresolved identity
   * must never keep the app alive or turn into an unbounded poll.
   */
  private scheduleRetry(attempt: number): void {
    if (attempt > MAX_IDENTITY_LOOKUP_ATTEMPTS) {
      return;
    }
    this.cancelRetry();
    const timer = setTimeout(
      () => {
        this.retryTimer = null;
        const activeApiKey = this.options.getApiKey();
        if (!activeApiKey) {
          // Signed out while the backoff ran; `resolve()` already announced null.
          return;
        }
        const activeCredentialKey = this.credentialKey(activeApiKey);
        if (this.cached?.credentialKey === activeCredentialKey) {
          return;
        }
        this.warm(activeApiKey, activeCredentialKey, attempt);
      },
      exponentialBackoffMs(
        attempt,
        IDENTITY_RETRY_BASE_MS,
        IDENTITY_RETRY_MAX_MS
      )
    );
    timer.unref?.();
    this.retryTimer = timer;
  }

  private cancelRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * `retryable` distinguishes "the lookup could not be completed" (offline, a
   * timeout, a 5xx, an origin not yet committed) from "the server answered and
   * this credential has no identity" (401/403, or a body that does not carry
   * one). Only the former is worth a second request; retrying a rejected key
   * would burn the whole ladder on an answer that will not change.
   */
  private async fetchIdentity(apiKey: string): Promise<IdentityFetchOutcome> {
    let url: string;
    try {
      url = new URL("/me", this.options.getApiOrigin()).toString();
    } catch {
      return { identity: null, retryable: false };
    }

    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return { identity: null, retryable: true };
    }
    if (!response.ok) {
      return { identity: null, retryable: response.status >= 500 };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { identity: null, retryable: true };
    }
    const data = unwrapApiResultData(body);
    return typeof data.id === "string" &&
      typeof data.organizationId === "string"
      ? {
          identity: { userId: data.id, organizationId: data.organizationId },
          retryable: false,
        }
      : { identity: null, retryable: false };
  }
}

/** Total `/me` attempts for one credential before the ladder gives up. */
const MAX_IDENTITY_LOOKUP_ATTEMPTS = 4;
const IDENTITY_RETRY_BASE_MS = 2000;
const IDENTITY_RETRY_MAX_MS = 30_000;

/** The outcome of one `/me` lookup: the identity, or why it produced none. */
type IdentityFetchOutcome = {
  identity: { userId: string; organizationId: string } | null;
  retryable: boolean;
};
