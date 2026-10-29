/**
 * ISS-12120: the main-thread twin of the Keychain probe,
 * `hasKeychainCredentialNonBlocking`. It shares the synchronous reader's memo,
 * TTLs and lookup, answers synchronously whenever no subprocess is needed, runs
 * at most one probe per service at a time, and settles as absent at its own
 * deadline when the child never exits, so no caller waits on it forever.
 */
import assert from "node:assert/strict";
import { userInfo } from "node:os";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
  ANTHROPIC_KEYCHAIN_SERVICE,
  hasKeychainCredentialCached,
  hasKeychainCredentialNonBlocking,
  type KeychainProbeNonBlockingDeps,
  keychainAccountName,
  resetKeychainCredentialCache,
} from "../src/main/cost/anthropic-keychain.js";
import {
  FAKE_SECURITY_SUITE_TIMEOUT_MS,
  FakeSecurityMode,
  installFakeSecurity,
  resetFakeSecurity,
} from "./support/fake-security-binary.js";
import {
  restorePlatform,
  stubPlatform,
} from "./support/keychain-probe-surfaces.js";

vi.mock("node:child_process", async (importOriginal) => {
  const { redirectSecurityBinary } = await import(
    "./support/fake-security-binary.js"
  );
  return redirectSecurityBinary(await importOriginal());
});

/** Async probe deps whose lookups the test settles by hand. */
function controlledProbe(platform = "darwin") {
  const pending: ((present: boolean) => void)[] = [];
  const deps: KeychainProbeNonBlockingDeps = {
    platform,
    account: "testuser",
    itemExists: () =>
      new Promise<boolean>((resolve) => {
        pending.push(resolve);
      }),
  };
  return { deps, pending };
}

beforeEach(() => {
  resetKeychainCredentialCache();
});

afterEach(() => {
  vi.useRealTimers();
  restorePlatform();
  resetFakeSecurity();
  resetKeychainCredentialCache();
});

describe("hasKeychainCredentialNonBlocking", {
  timeout: FAKE_SECURITY_SUITE_TIMEOUT_MS,
}, () => {
  test("a fresh memo answers synchronously, from the synchronous reader's entry", () => {
    const now = 1_000_000;
    hasKeychainCredentialCached(ANTHROPIC_KEYCHAIN_SERVICE, now, {
      platform: "darwin",
      account: "testuser",
      itemExists: () => true,
    });
    const { deps, pending } = controlledProbe();

    const answer = hasKeychainCredentialNonBlocking(
      ANTHROPIC_KEYCHAIN_SERVICE,
      now + 9 * 60_000,
      deps
    );

    assert.equal(answer, true);
    assert.equal(pending.length, 0, "a fresh memo must not probe");
  });

  test("off macOS it answers absent synchronously and never probes", () => {
    const { deps, pending } = controlledProbe("linux");

    const answer = hasKeychainCredentialNonBlocking(
      ANTHROPIC_KEYCHAIN_SERVICE,
      2_000_000,
      deps
    );

    assert.equal(answer, false);
    assert.equal(pending.length, 0);
  });

  test("concurrent cold callers share one probe, and its answer fills the memo", async () => {
    const now = 3_000_000;
    const { deps, pending } = controlledProbe();

    const first = hasKeychainCredentialNonBlocking(
      ANTHROPIC_KEYCHAIN_SERVICE,
      now,
      deps
    );
    const second = hasKeychainCredentialNonBlocking(
      ANTHROPIC_KEYCHAIN_SERVICE,
      now + 5,
      deps
    );
    assert.ok(first instanceof Promise && second instanceof Promise);
    assert.equal(pending.length, 1, "two cold callers spawned two probes");
    pending[0]?.(true);

    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    // Memoized with the PRESENT TTL measured from the first caller's clock.
    assert.equal(
      hasKeychainCredentialNonBlocking(
        ANTHROPIC_KEYCHAIN_SERVICE,
        now + 10 * 60_000 - 1,
        deps
      ),
      true
    );
    assert.equal(pending.length, 1);
  });

  test("an ABSENT answer expires after the short TTL, as the synchronous memo's does", async () => {
    const now = 4_000_000;
    const { deps, pending } = controlledProbe();
    const probe = hasKeychainCredentialNonBlocking(
      ANTHROPIC_KEYCHAIN_SERVICE,
      now,
      deps
    );
    pending[0]?.(false);
    assert.equal(await probe, false);

    assert.equal(
      hasKeychainCredentialNonBlocking(
        ANTHROPIC_KEYCHAIN_SERVICE,
        now + 59_999,
        deps
      ),
      false
    );
    const reprobe = hasKeychainCredentialNonBlocking(
      ANTHROPIC_KEYCHAIN_SERVICE,
      now + 60_001,
      deps
    );

    assert.ok(reprobe instanceof Promise);
    assert.equal(pending.length, 2, "absent TTL expiry forces a re-probe");
  });

  test("a probe whose child never exits settles absent at its deadline and frees its slot", async () => {
    // The deadline answers from a real `setImmediate` after its faked timer.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const now = 5_000_000;
    const { deps, pending } = controlledProbe();
    const hung = hasKeychainCredentialNonBlocking(
      ANTHROPIC_KEYCHAIN_SERVICE,
      now,
      deps
    );
    const joined = hasKeychainCredentialNonBlocking(
      ANTHROPIC_KEYCHAIN_SERVICE,
      now,
      deps
    );

    // The 800 ms probe timeout plus the 200 ms grace.
    await vi.advanceTimersByTimeAsync(1000);

    assert.deepEqual(await Promise.all([hung, joined]), [false, false]);
    // The absent answer is memoized for the short TTL...
    assert.equal(
      hasKeychainCredentialNonBlocking(
        ANTHROPIC_KEYCHAIN_SERVICE,
        now + 59_999,
        deps
      ),
      false
    );
    assert.equal(pending.length, 1);
    // ...and the slot is free once it expires.
    assert.equal(
      hasKeychainCredentialNonBlocking(
        ANTHROPIC_KEYCHAIN_SERVICE,
        now + 60_001,
        deps
      ) instanceof Promise,
      true
    );
    assert.equal(pending.length, 2, "the next cold call starts a new probe");
  });

  test("a reset while a probe runs keeps its late answer out of the memo", async () => {
    const now = 6_000_000;
    const { deps, pending } = controlledProbe();
    const late = hasKeychainCredentialNonBlocking(
      ANTHROPIC_KEYCHAIN_SERVICE,
      now,
      deps
    );

    resetKeychainCredentialCache();
    pending[0]?.(true);

    assert.equal(await late, true);
    const after = hasKeychainCredentialNonBlocking(
      ANTHROPIC_KEYCHAIN_SERVICE,
      now + 1,
      deps
    );
    assert.ok(after instanceof Promise, "the late answer reached the memo");
  });

  test("the live lookup runs the existence-only security command", async () => {
    stubPlatform("darwin");
    const fake = installFakeSecurity(FakeSecurityMode.Present);

    const answer = await hasKeychainCredentialNonBlocking(
      ANTHROPIC_KEYCHAIN_SERVICE,
      7_000_000
    );

    assert.equal(answer, true);
    // Exactly these arguments: the account and service scope, and never `-w`.
    assert.deepEqual(fake.args(), [
      "find-generic-password",
      "-a",
      keychainAccountName(process.env, userInfo().username),
      "-s",
      ANTHROPIC_KEYCHAIN_SERVICE,
    ]);
  });

  test("a child that exited 0 counts as present even when a busy main thread fired the timers first", async () => {
    stubPlatform("darwin");
    const fake = installFakeSecurity(FakeSecurityMode.Present);

    const answer = hasKeychainCredentialNonBlocking(
      ANTHROPIC_KEYCHAIN_SERVICE,
      8_000_000
    );
    // Hold the event loop past both the 800 ms timeout and the 1000 ms
    // deadline, and until the child has answered. Its exit is only delivered
    // after the expired timers run; the synchronous probe measured the child.
    holdEventLoopUntil(fake.answered, 1100);

    assert.equal(await answer, true);
    assert.ok(fake.started());
  });
});

/** Ceiling on {@link holdEventLoopUntil}, so a child that never answers fails by name. */
const HOLD_BOUND_MS = 8000;

/**
 * Busy-wait on this thread until `answered()` holds and at least `minimumMs`
 * has passed, so no timer or I/O callback can run meanwhile.
 */
function holdEventLoopUntil(answered: () => boolean, minimumMs: number): void {
  const start = Date.now();
  for (;;) {
    const elapsed = Date.now() - start;
    if (elapsed >= minimumMs && answered()) {
      return;
    }
    if (elapsed > HOLD_BOUND_MS) {
      throw new Error("the fake security never answered");
    }
  }
}
