/**
 * @file anthropic-keychain.test.ts
 * @description ISS-4869. Covers the macOS Keychain existence probe that feeds
 * the billing-mode engine's optional `hasKeychainCredential` dep: platform
 * gating, account-name derivation, failure degradation, and the TTL memo that
 * keeps per-session-row detection from spawning a subprocess per row.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, test } from "node:test";
import {
  ANTHROPIC_KEYCHAIN_SERVICE,
  anthropicKeychainService,
  hasKeychainCredentialCached,
  type KeychainProbeDeps,
  keychainAccountName,
  probeKeychainCredential,
  resetKeychainCredentialCache,
} from "../src/main/cost/anthropic-keychain.js";

/**
 * Probe deps backed by a recorded call log, so spawn counts are assertable.
 *
 * `present` lists services the CONFIGURED account holds an item for.
 * `presentOtherAccount` lists services some OTHER account on the machine holds
 * an item for — these must never be visible to an account-scoped lookup.
 */
function makeProbe(opts: {
  platform?: string;
  account?: string;
  present?: string[];
  throws?: boolean;
  presentOtherAccount?: string[];
}): { deps: KeychainProbeDeps; calls: [string, string][] } {
  const calls: [string, string][] = [];
  const account = opts.account ?? "testuser";
  const present = new Set(opts.present ?? []);
  const presentOtherAccount = new Set(opts.presentOtherAccount ?? []);
  return {
    calls,
    deps: {
      platform: opts.platform ?? "darwin",
      account,
      itemExists: (service: string, lookupAccount: string): boolean => {
        calls.push([service, lookupAccount]);
        if (opts.throws) {
          throw new Error("security: item search failed");
        }
        if (present.has(service) && lookupAccount === account) {
          return true;
        }
        // Only a lookup naming the other account could ever see these.
        return (
          presentOtherAccount.has(service) && lookupAccount === "someone-else"
        );
      },
    },
  };
}

beforeEach(() => {
  resetKeychainCredentialCache();
});

// ── Account-name derivation ─────────────────────────────────────────────────

test("keychainAccountName prefers $USER, then the OS username", () => {
  assert.equal(keychainAccountName({ USER: "mike" }, "fallback"), "mike");
  assert.equal(keychainAccountName({}, "os-user"), "os-user");
});

test("keychainAccountName falls back when the name is missing or unusable", () => {
  assert.equal(keychainAccountName({}, null), "claude-code-user");
  assert.equal(keychainAccountName({ USER: "" }, null), "claude-code-user");
  // Outside Claude Code's accepted charset → the CLI's own fallback.
  for (const bad of ["has space", "sneaky;rm -rf /", 'quote"name', "a/b"]) {
    assert.equal(
      keychainAccountName({ USER: bad }, null),
      "claude-code-user",
      bad
    );
  }
  // Accepted charset passes through untouched.
  for (const ok of ["mike.angstadt", "user_1", "a-b", "CAPS"]) {
    assert.equal(keychainAccountName({ USER: ok }, null), ok, ok);
  }
});

// ── Service-name composition (default vs relocated profile) ─────────────────

test("anthropicKeychainService returns the unsuffixed name for the default profile", () => {
  assert.equal(anthropicKeychainService(null), ANTHROPIC_KEYCHAIN_SERVICE);
  assert.equal(ANTHROPIC_KEYCHAIN_SERVICE, "Claude Code-credentials");
});

test("a relocated profile gets the default name plus an 8-char config-dir hash", () => {
  const configDir = "/relocated/claude";
  const expected = createHash("sha256")
    .update(configDir)
    .digest("hex")
    .slice(0, 8);
  assert.equal(
    anthropicKeychainService(configDir),
    `${ANTHROPIC_KEYCHAIN_SERVICE}-${expected}`
  );
});

test("distinct relocated profiles never collapse onto the same service", () => {
  // The suffix is what stops one profile claiming another's credential — and
  // stops a relocated profile claiming the DEFAULT profile's leftover item.
  const a = anthropicKeychainService("/relocated/a");
  const b = anthropicKeychainService("/relocated/b");
  assert.notEqual(a, b);
  assert.notEqual(a, ANTHROPIC_KEYCHAIN_SERVICE);
  assert.notEqual(b, ANTHROPIC_KEYCHAIN_SERVICE);
  // Stable across calls, so the memo keys stay consistent within a run.
  assert.equal(anthropicKeychainService("/relocated/a"), a);
});

// ── Platform gating + failure degradation ───────────────────────────────────

test("probeKeychainCredential finds a present item on macOS", () => {
  const { deps, calls } = makeProbe({
    present: [ANTHROPIC_KEYCHAIN_SERVICE],
    account: "mike",
  });
  assert.equal(probeKeychainCredential(ANTHROPIC_KEYCHAIN_SERVICE, deps), true);
  assert.deepEqual(calls, [[ANTHROPIC_KEYCHAIN_SERVICE, "mike"]]);
});

test("probeKeychainCredential returns false when the item is absent", () => {
  const { deps, calls } = makeProbe({ present: [] });
  assert.equal(
    probeKeychainCredential(ANTHROPIC_KEYCHAIN_SERVICE, deps),
    false
  );
  // Exactly one account-scoped lookup — no widening retry.
  assert.deepEqual(calls, [[ANTHROPIC_KEYCHAIN_SERVICE, "testuser"]]);
});

test("another account's credential never classifies this session", () => {
  // The lookup identity is (service, account), not (service). A stale item left
  // by a different user of the same machine must stay invisible: reporting it
  // would mark real metered spend as subscription-covered and drop it off the
  // headline ledger.
  const { deps, calls } = makeProbe({
    account: "electron-user",
    present: [],
    presentOtherAccount: [ANTHROPIC_KEYCHAIN_SERVICE],
  });
  assert.equal(
    probeKeychainCredential(ANTHROPIC_KEYCHAIN_SERVICE, deps),
    false
  );
  assert.deepEqual(calls, [[ANTHROPIC_KEYCHAIN_SERVICE, "electron-user"]]);
});

test("the lookup pins the exact service name as well as the account", () => {
  // An unrelated app's item can never be mistaken for a Claude credential.
  const { deps } = makeProbe({ present: ["Some Other App-credentials"] });
  assert.equal(
    probeKeychainCredential(ANTHROPIC_KEYCHAIN_SERVICE, deps),
    false
  );
});

test("probeKeychainCredential issues at most one lookup per probe", () => {
  // The probe runs synchronously inside the DB write queue, so its worst case
  // must be ONE subprocess deadline, never a multiple of it.
  for (const present of [[ANTHROPIC_KEYCHAIN_SERVICE], []]) {
    const { deps, calls } = makeProbe({ present });
    probeKeychainCredential(ANTHROPIC_KEYCHAIN_SERVICE, deps);
    assert.equal(calls.length, 1, `one lookup (present=${present.length})`);
  }
});

test("probeKeychainCredential never runs off macOS", () => {
  for (const platform of ["linux", "win32", "freebsd"]) {
    const { deps, calls } = makeProbe({
      platform,
      present: [ANTHROPIC_KEYCHAIN_SERVICE],
    });
    assert.equal(
      probeKeychainCredential(ANTHROPIC_KEYCHAIN_SERVICE, deps),
      false,
      platform
    );
    assert.equal(calls.length, 0, `no subprocess attempted on ${platform}`);
  }
});

test("probeKeychainCredential degrades to false when the lookup throws", () => {
  const { deps } = makeProbe({ throws: true });
  assert.equal(
    probeKeychainCredential(ANTHROPIC_KEYCHAIN_SERVICE, deps),
    false
  );
});

// ── Memoization (the per-row spawn guard) ───────────────────────────────────

test("hasKeychainCredentialCached probes once and serves the memo within the TTL", () => {
  const { deps, calls } = makeProbe({ present: [ANTHROPIC_KEYCHAIN_SERVICE] });
  const start = 1_000_000;
  // Stand in for an import batch: many rows, one machine-level question.
  for (let i = 0; i < 500; i++) {
    assert.equal(
      hasKeychainCredentialCached(ANTHROPIC_KEYCHAIN_SERVICE, start + i, deps),
      true
    );
  }
  assert.equal(calls.length, 1, "500 detections must collapse to one probe");
});

test("an ABSENT answer re-probes after the short TTL so a fresh login heals", () => {
  const { deps, calls } = makeProbe({ present: [] });
  const start = 2_000_000;
  assert.equal(
    hasKeychainCredentialCached(ANTHROPIC_KEYCHAIN_SERVICE, start, deps),
    false
  );
  assert.equal(
    hasKeychainCredentialCached(
      ANTHROPIC_KEYCHAIN_SERVICE,
      start + 59_999,
      deps
    ),
    false
  );
  // One miss = one account-scoped lookup, memoized after.
  assert.equal(calls.length, 1, "still inside the absent TTL");

  // Past the 1-minute absent TTL the answer is re-derived — a user who logs in
  // mid-session heals without restarting the app.
  const loggedIn = makeProbe({ present: [ANTHROPIC_KEYCHAIN_SERVICE] });
  assert.equal(
    hasKeychainCredentialCached(
      ANTHROPIC_KEYCHAIN_SERVICE,
      start + 60_001,
      loggedIn.deps
    ),
    true
  );
  assert.equal(loggedIn.calls.length, 1, "absent TTL expiry forces a re-probe");
});

test("a PRESENT answer is held far longer than an absent one", () => {
  // The asymmetry is the point: on the machines this fix targets, the steady
  // state must not spawn `security` once a minute forever.
  const { deps, calls } = makeProbe({ present: [ANTHROPIC_KEYCHAIN_SERVICE] });
  const start = 5_000_000;
  assert.equal(
    hasKeychainCredentialCached(ANTHROPIC_KEYCHAIN_SERVICE, start, deps),
    true
  );
  // Well past the 1-minute absent TTL, still inside the 10-minute present TTL.
  assert.equal(
    hasKeychainCredentialCached(
      ANTHROPIC_KEYCHAIN_SERVICE,
      start + 9 * 60_000,
      deps
    ),
    true
  );
  assert.equal(calls.length, 1, "present answer survives past the absent TTL");

  assert.equal(
    hasKeychainCredentialCached(
      ANTHROPIC_KEYCHAIN_SERVICE,
      start + 10 * 60_000 + 1,
      deps
    ),
    true
  );
  assert.equal(calls.length, 2, "present TTL still expires eventually");
});

test("hasKeychainCredentialCached keeps distinct services on distinct memo slots", () => {
  const { deps, calls } = makeProbe({ present: [ANTHROPIC_KEYCHAIN_SERVICE] });
  const now = 3_000_000;
  assert.equal(
    hasKeychainCredentialCached(ANTHROPIC_KEYCHAIN_SERVICE, now, deps),
    true
  );
  assert.equal(
    hasKeychainCredentialCached("Other-credentials", now, deps),
    false
  );
  // One account-scoped lookup each: the hit plus the miss.
  assert.equal(calls.length, 2);
  // Both are now memoized independently.
  assert.equal(
    hasKeychainCredentialCached(ANTHROPIC_KEYCHAIN_SERVICE, now, deps),
    true
  );
  assert.equal(
    hasKeychainCredentialCached("Other-credentials", now, deps),
    false
  );
  assert.equal(calls.length, 2, "no additional probes");
});

test("the memo stays bounded no matter how many services are probed", () => {
  const { deps } = makeProbe({ present: [] });
  const now = 4_000_000;
  for (let i = 0; i < 200; i++) {
    hasKeychainCredentialCached(`service-${i}`, now, deps);
  }
  // Bounded by construction: the cap clears rather than accumulating. Observable
  // proof is that a long-since-probed service is no longer memoized.
  const { deps: recheck, calls } = makeProbe({ present: [] });
  hasKeychainCredentialCached("service-0", now, recheck);
  assert.equal(
    calls.length,
    1,
    "evicted entry was re-probed, so it was dropped"
  );
});
