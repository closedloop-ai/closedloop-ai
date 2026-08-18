/**
 * @file anthropic-keychain.ts
 * @description ISS-4869. Existence-only macOS Keychain probe for Claude Code's
 * OAuth credential, injected into the pure billing-mode engine as its optional
 * `hasKeychainCredential` dependency.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * Claude Code stores its OAuth credential in the login Keychain by default on
 * macOS, NOT at `<configDir>/.credentials.json`. The engine only knew about the
 * file, so every Claude session on macOS classified as `unknown` and its
 * subscription-covered cost was summed into headline "real spend".
 *
 * ── Secret-handling rule (non-negotiable) ─────────────────────────────────────
 * `security find-generic-password` is invoked WITHOUT `-w`, so the stored secret
 * is never requested, never returned, and never enters this process at all. Only
 * the exit code is consulted; all three stdio streams are discarded. Omitting
 * `-w` also keeps the lookup to item *attributes*, which macOS does not gate
 * behind the Keychain ACL — so this never raises an authorization prompt at the
 * user. Do not add `-w` here.
 *
 * ── Why it is cached, and why the TTL is asymmetric ───────────────────────────
 * `detectBillingMode` is called per session row at ingest — inside the
 * single-writer write-queue transaction (`database/write-core.ts`,
 * `database/live-hook.ts`) — and again for every stored-`unknown` row on the
 * synchronous sync/reconciliation read paths (`cost/reconciliation-worker.ts`).
 * That is thousands of calls on a real install, and `execFileSync` BLOCKS the
 * calling thread, so an unmemoized spawn there would stall the write queue per
 * row. The answer is therefore memoized, with a deliberately asymmetric TTL:
 *
 *   - PRESENT is cached for 10 minutes. A subscription credential does not
 *     disappear mid-session, and this is the machine state the fix targets, so
 *     the steady state costs ~one spawn per 10 minutes.
 *   - ABSENT is cached for only 1 minute, so a user who logs into Claude Code
 *     while the app is running heals quickly instead of waiting out a long TTL.
 *
 * Combined with the short subprocess timeout below, the worst case is a bounded
 * sub-second stall at most once per minute, on macOS only.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { userInfo } from "node:os";

/**
 * Kill a wedged `security` call rather than stalling the write queue. A local
 * Keychain metadata lookup answers in single-digit milliseconds, so this is
 * generous; it exists to bound a pathological hang, not a normal lookup.
 */
const KEYCHAIN_PROBE_TIMEOUT_MS = 800;

/** Memo lifetime for a FOUND credential — see the header's TTL rationale. */
const KEYCHAIN_PROBE_TTL_PRESENT_MS = 10 * 60_000;

/** Memo lifetime for a MISSING credential — short so a fresh login heals fast. */
const KEYCHAIN_PROBE_TTL_ABSENT_MS = 60_000;

/**
 * Bound on the memo. Exactly one service is probed today; the cap exists so the
 * map can never accumulate entries, per the repo's unbounded-cache rule.
 */
const KEYCHAIN_CACHE_MAX_ENTRIES = 8;

/**
 * Absolute path to the macOS `security` binary. Resolved absolutely, NEVER by
 * name: `execFileSync("security", …)` would search the inherited `PATH`, so a
 * shadow `security` earlier on that PATH would execute with Desktop's
 * privileges. This is a trusted OS utility and is addressed as one.
 */
const SECURITY_BINARY_PATH = "/usr/bin/security";

/**
 * Account-name charset Claude Code accepts before falling back. Mirrored from
 * the shipped CLI so this probe derives the same account it stores under.
 */
const KEYCHAIN_ACCOUNT_PATTERN = /^[a-zA-Z0-9._-]+$/;

/** Claude Code's own fallback when the username is missing or unusable. */
const KEYCHAIN_ACCOUNT_FALLBACK = "claude-code-user";

/** Injected seam so the probe is testable without a real Keychain. */
export type KeychainProbeDeps = {
  /** `process.platform` — the probe is a no-op off macOS. */
  platform: string;
  /** Keychain account name to look the item up under. */
  account: string;
  /**
   * Existence-only lookup: true when the item is present under BOTH this exact
   * service and this exact account. The account is never widened — see
   * `probeKeychainCredential`.
   */
  itemExists: (service: string, account: string) => boolean;
};

type KeychainCacheEntry = { value: boolean; expiresAt: number };

const keychainCache = new Map<string, KeychainCacheEntry>();

/**
 * Derive the Keychain account name Claude Code stores its credential under:
 * `$USER`, else the OS username, else a fixed fallback. Values outside the
 * accepted charset fall back too, matching the CLI's own normalization.
 */
export function keychainAccountName(
  env: Record<string, string | undefined>,
  osUserName: string | null
): string {
  const candidate = env.USER || osUserName || "";
  return KEYCHAIN_ACCOUNT_PATTERN.test(candidate)
    ? candidate
    : KEYCHAIN_ACCOUNT_FALLBACK;
}

/**
 * Uncached, fully-injected existence check. Returns false on any non-macOS
 * platform and on any probe failure — a failed probe must degrade to "no
 * signal", never to a wrong billing classification.
 *
 * EXACTLY ONE lookup, `(service, account)` — precisely how Claude Code stores
 * and reads the item (`add-generic-password -U -a <$USER> -s <service>`).
 *
 * The account filter is deliberately NOT widened. An earlier revision retried
 * service-only (no `-a`) to survive a `$USER` mismatch between the shell that
 * logged in and this Electron process, but that widens the credential identity
 * from "the Claude account" to "any account using this service": a stale item
 * left by another user on a shared machine would then classify the current
 * session as subscription-covered even though the account-scoped read misses
 * it — moving real metered spend off the headline ledger. A missed detection
 * degrades to the pre-existing `unknown`; a false subscription silently
 * understates real spend, so the narrow lookup is the correct trade.
 *
 * Keeping it to one lookup also bounds the probe at a single
 * KEYCHAIN_PROBE_TIMEOUT_MS deadline rather than a multiple of it, which
 * matters because detection runs synchronously inside the DB write queue.
 */
export function probeKeychainCredential(
  service: string,
  deps: KeychainProbeDeps
): boolean {
  if (deps.platform !== "darwin") {
    return false;
  }
  try {
    return deps.itemExists(service, deps.account);
  } catch {
    return false;
  }
}

/**
 * Real macOS lookup. Existence-only — see the secret-handling rule above; the
 * secret is never requested and all output is discarded. Both `-a` (account)
 * and `-s` (service) are always supplied, so the item identity stays exactly as
 * narrow as the one Claude Code itself writes.
 */
function securityItemExists(service: string, account: string): boolean {
  const args = ["find-generic-password", "-a", account, "-s", service];
  try {
    execFileSync(SECURITY_BINARY_PATH, args, {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: KEYCHAIN_PROBE_TIMEOUT_MS,
    });
    return true;
  } catch {
    // Non-zero exit (item absent), timeout, or `security` missing entirely.
    return false;
  }
}

/** Live probe deps for desktop-main. */
function realProbeDeps(): KeychainProbeDeps {
  let osUserName: string | null = null;
  try {
    osUserName = userInfo().username;
  } catch {
    osUserName = null;
  }
  return {
    platform: process.platform,
    account: keychainAccountName(process.env, osUserName),
    itemExists: securityItemExists,
  };
}

/**
 * Cached existence check used as the engine's `hasKeychainCredential` dep.
 * `now` is injected so the TTL is testable without a real clock.
 *
 * `deps` is resolved lazily, AFTER the cache lookup: building the real deps
 * costs an `os.userInfo()` syscall, and this runs once per session row, so a
 * cache hit must stay pure bookkeeping.
 */
export function hasKeychainCredentialCached(
  service: string,
  now: number = Date.now(),
  deps?: KeychainProbeDeps
): boolean {
  const cached = keychainCache.get(service);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const value = probeKeychainCredential(service, deps ?? realProbeDeps());
  if (keychainCache.size >= KEYCHAIN_CACHE_MAX_ENTRIES) {
    keychainCache.clear();
  }
  const ttl = value
    ? KEYCHAIN_PROBE_TTL_PRESENT_MS
    : KEYCHAIN_PROBE_TTL_ABSENT_MS;
  keychainCache.set(service, { value, expiresAt: now + ttl });
  return value;
}

/** Drop the memo. Test-only seam; production relies on the TTL. */
export function resetKeychainCredentialCache(): void {
  keychainCache.clear();
}

/**
 * macOS Keychain service name Claude Code stores its OAuth credential under, for
 * the DEFAULT profile. The shipped CLI (v2.1.220) composes it as `Claude Code` +
 * an empty prod OAuth suffix + `-credentials`.
 */
export const ANTHROPIC_KEYCHAIN_SERVICE = "Claude Code-credentials";

/** Length of the config-dir hash the CLI appends for a relocated profile. */
const KEYCHAIN_PROFILE_HASH_LENGTH = 8;

/**
 * Compose the Keychain service name for a Claude Code profile: the default name
 * for `null`, else that name plus the CLI's `-<sha256(configDir)[0..8]>` suffix.
 *
 * This composition lives HERE, in the Node adapter, rather than in the pure
 * `shared/billing-mode.ts` engine, precisely because it needs `node:crypto`.
 *
 * Fail-safe by construction: if this derivation ever diverges from the CLI's,
 * the probe simply finds nothing and detection degrades to the pre-existing
 * `unknown`. It cannot produce a FALSE subscription, because a mismatched hash
 * is not some other profile's hash — and the lookup is additionally scoped to
 * this process's own account (see `probeKeychainCredential`). A miss costs an
 * unclassified row; a false positive would move real metered spend off the
 * headline ledger, which is the failure this ordering rules out.
 */
export function anthropicKeychainService(configDir: string | null): string {
  if (configDir === null) {
    return ANTHROPIC_KEYCHAIN_SERVICE;
  }
  const digest = createHash("sha256")
    .update(configDir)
    .digest("hex")
    .slice(0, KEYCHAIN_PROFILE_HASH_LENGTH);
  return `${ANTHROPIC_KEYCHAIN_SERVICE}-${digest}`;
}
