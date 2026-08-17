/**
 * ISS-5300 (PRD-618): managed-key-hint-ipc.ts had no prior test coverage.
 *
 * Per apps/desktop/src/main/ipc/desktop-ipc-registration.ts:232-234:
 *   "Two registrars are deliberately ungated and read no renderer input: …
 *   `registerManagedKeyHintIpcHandlers` (main-process-sourced hint state)."
 *
 * The critical coverage here is the fail-closed catch arms in both handlers
 * (managed-key-hint-ipc.ts:48-62 and :68-81). Each catch arm is tested in a
 * separate test from its happy path so that the positive control cannot pass
 * by the catch arm silently swallowing a production failure (PRD-618 rule 1).
 *
 * Safe defaults confirmed from source:
 *   GetManagedKeyHintState  catch → { shouldShow: false, provenance: null }  (:61)
 *   DismissManagedKeyHint   catch → { success: false }                       (:80)
 *
 * managed-key-hint-ipc.ts:36 calls new Date().toISOString() inside
 * buildDismissState; tests that assert the stored dismissedAt value pin the
 * clock with mock.timers so the result is deterministic.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  ManagedKeyHintIpcChannel,
  registerManagedKeyHintIpcHandlers,
} from "../src/main/ipc/managed-key-hint-ipc.js";
import type { ApiKeyStore } from "../src/main/settings/api-key-store.js";
import type { SettingsStore } from "../src/main/settings/settings-store.js";
import type { ApiKeyProvenance } from "../src/shared/contracts.js";
import {
  createIpcRegistrar,
  TRUSTED_EVENT,
  UNTRUSTED_EVENT,
} from "./helpers/ipc-registrar.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

// ---------------------------------------------------------------------------
// Pinned time for dismissedAt assertions (managed-key-hint-ipc.ts:36).
// PINNED_ISO is computed from a fixed epoch millis — deterministic regardless
// of wall-clock time at module load.
// ---------------------------------------------------------------------------
const PINNED_TS = 1_700_000_000_000;
const PINNED_ISO = new Date(PINNED_TS).toISOString();

// ---------------------------------------------------------------------------
// Store doubles
// ---------------------------------------------------------------------------

function makeApiKeyStoreDouble(
  opts: { provenance?: ApiKeyProvenance | null; throwOnGet?: boolean } = {}
): ApiKeyStore {
  const { provenance = "USER_CREATED", throwOnGet = false } = opts;
  return {
    getApiKeyProvenance(): ApiKeyProvenance | null {
      if (throwOnGet) {
        throw new Error("simulated apiKeyStore failure");
      }
      return provenance;
    },
  } as unknown as ApiKeyStore;
}

type SettingsStoreCalls = {
  setDismissedAt: (string | null)[];
  setLastSeenProvenance: ("DESKTOP_MANAGED" | "USER_CREATED")[];
};

function makeSettingsStoreDouble(
  opts: {
    dismissedAt?: string | null;
    lastSeenProvenance?: "DESKTOP_MANAGED" | "USER_CREATED" | null;
    throwOnSet?: boolean;
  } = {}
): { store: SettingsStore; calls: SettingsStoreCalls } {
  const {
    dismissedAt = null,
    lastSeenProvenance = null,
    throwOnSet = false,
  } = opts;
  const calls: SettingsStoreCalls = {
    setDismissedAt: [],
    setLastSeenProvenance: [],
  };
  const store = {
    getManagedKeyHintDismissedAt: (): string | null => dismissedAt,
    getManagedKeyHintLastSeenProvenance: ():
      | "DESKTOP_MANAGED"
      | "USER_CREATED"
      | null => lastSeenProvenance,
    setManagedKeyHintDismissedAt(value: string | null): void {
      if (throwOnSet) {
        throw new Error("simulated settingsStore failure");
      }
      calls.setDismissedAt.push(value);
    },
    setManagedKeyHintLastSeenProvenance(
      value: "DESKTOP_MANAGED" | "USER_CREATED"
    ): void {
      calls.setLastSeenProvenance.push(value);
    },
  } as unknown as SettingsStore;
  return { store, calls };
}

function makeRegistration(
  opts: {
    provenance?: ApiKeyProvenance | null;
    dismissedAt?: string | null;
    lastSeenProvenance?: "DESKTOP_MANAGED" | "USER_CREATED" | null;
    apiKeyStoreThrows?: boolean;
    settingsStoreThrowsOnSet?: boolean;
  } = {}
) {
  const apiKeyStore = makeApiKeyStoreDouble({
    provenance: opts.provenance ?? "USER_CREATED",
    throwOnGet: opts.apiKeyStoreThrows ?? false,
  });
  const { store: settingsStore, calls } = makeSettingsStoreDouble({
    dismissedAt: opts.dismissedAt ?? null,
    lastSeenProvenance: opts.lastSeenProvenance ?? null,
    throwOnSet: opts.settingsStoreThrowsOnSet ?? false,
  });
  const harness = createIpcRegistrar();
  registerManagedKeyHintIpcHandlers(harness.registrar, {
    apiKeyStore,
    settingsStore,
  });
  return { harness, calls };
}

// ---------------------------------------------------------------------------
// Channel registration
// ---------------------------------------------------------------------------

describe("managed-key-hint IPC registration", () => {
  test("registers exactly the channels declared in ManagedKeyHintIpcChannel", () => {
    const { harness } = makeRegistration();
    assert.deepEqual(
      [...harness.channels()].sort(),
      Object.values(ManagedKeyHintIpcChannel).sort()
    );
  });
});

// ---------------------------------------------------------------------------
// GetManagedKeyHintState
// Invoked with UNTRUSTED_EVENT to assert the "deliberately ungated" posture
// from desktop-ipc-registration.ts:232-234. A gate being added would flip
// these to throwing "untrusted sender" errors rather than returning data.
// ---------------------------------------------------------------------------

describe("GetManagedKeyHintState", () => {
  test("returns provenance and shouldShow=true when USER_CREATED and never dismissed", () => {
    // shouldShowManagedKeyHint("USER_CREATED", null, null) → true
    const { harness } = makeRegistration({
      provenance: "USER_CREATED",
      dismissedAt: null,
      lastSeenProvenance: null,
    });

    const result = harness.invoke(
      ManagedKeyHintIpcChannel.GetManagedKeyHintState,
      UNTRUSTED_EVENT
    );

    assert.deepEqual(result, { provenance: "USER_CREATED", shouldShow: true });
  });

  test("returns shouldShow=false when provenance is DESKTOP_MANAGED", () => {
    // shouldShowManagedKeyHint("DESKTOP_MANAGED", null, null) → false
    const { harness } = makeRegistration({
      provenance: "DESKTOP_MANAGED",
      dismissedAt: null,
      lastSeenProvenance: null,
    });

    const result = harness.invoke(
      ManagedKeyHintIpcChannel.GetManagedKeyHintState,
      UNTRUSTED_EVENT
    );

    assert.deepEqual(result, {
      provenance: "DESKTOP_MANAGED",
      shouldShow: false,
    });
  });

  test("catch arm: returns safe default { shouldShow: false, provenance: null } when apiKeyStore throws", () => {
    // Exercises the catch block at managed-key-hint-ipc.ts:59-61.
    // Separated from the happy-path tests so the positive control cannot pass
    // because the catch arm swallowed a real handler failure (PRD-618 rule 1).
    const { harness } = makeRegistration({ apiKeyStoreThrows: true });

    const result = harness.invoke(
      ManagedKeyHintIpcChannel.GetManagedKeyHintState,
      UNTRUSTED_EVENT
    );

    // Exact shape from source line :61
    assert.deepEqual(result, { shouldShow: false, provenance: null });
  });
});

// ---------------------------------------------------------------------------
// DismissManagedKeyHint
// ---------------------------------------------------------------------------

describe("DismissManagedKeyHint", () => {
  afterEach(() => {
    nodeTestTimers.reset();
  });

  test("stores pinned dismissedAt ISO and provenance from apiKeyStore, returns { success: true }", () => {
    // managed-key-hint-ipc.ts:36 calls new Date().toISOString() inside
    // buildDismissState. Pin the clock so the stored value is deterministic.
    nodeTestTimers.enable(["Date"], { now: PINNED_TS });

    const { harness, calls } = makeRegistration({ provenance: "USER_CREATED" });

    const result = harness.invoke(
      ManagedKeyHintIpcChannel.DismissManagedKeyHint,
      UNTRUSTED_EVENT
    );

    assert.deepEqual(result, { success: true });
    assert.deepEqual(calls.setDismissedAt, [PINNED_ISO]);
    assert.deepEqual(calls.setLastSeenProvenance, ["USER_CREATED"]);
  });

  test("sources provenance from apiKeyStore only, not from renderer IPC args", () => {
    // Asserts the docstring claim from desktop-ipc-registration.ts:232-234:
    // "read no renderer input." The handler signature is `(): { success: boolean }`;
    // provenance is sourced exclusively from apiKeyStore.getApiKeyProvenance()
    // (managed-key-hint-ipc.ts:34), never from event args.
    //
    // If the handler were modified to read the second IPC arg as provenance,
    // calls.setLastSeenProvenance[0] would be "DESKTOP_MANAGED" instead of
    // "USER_CREATED", making this assertion falsifiable.
    const { harness, calls } = makeRegistration({ provenance: "USER_CREATED" });

    const result = harness.invoke(
      ManagedKeyHintIpcChannel.DismissManagedKeyHint,
      TRUSTED_EVENT,
      "DESKTOP_MANAGED" // renderer-supplied arg; must be ignored by the handler
    );

    assert.deepEqual(result, { success: true });
    // Stored provenance must come from apiKeyStore ("USER_CREATED"), not args:
    assert.deepEqual(calls.setLastSeenProvenance, ["USER_CREATED"]);
  });

  test("catch arm: returns safe default { success: false } when settingsStore throws", () => {
    // Exercises the catch block at managed-key-hint-ipc.ts:79-81.
    // Separated from the happy-path test so the positive control cannot pass
    // because the catch arm swallowed a real handler failure (PRD-618 rule 1).
    // Using settingsStoreThrowsOnSet verifies the catch arm fires even when
    // buildDismissState itself succeeds (a later failure path).
    nodeTestTimers.enable(["Date"], { now: PINNED_TS });
    const { harness } = makeRegistration({ settingsStoreThrowsOnSet: true });

    const result = harness.invoke(
      ManagedKeyHintIpcChannel.DismissManagedKeyHint,
      UNTRUSTED_EVENT
    );

    // Exact shape from source line :80
    assert.deepEqual(result, { success: false });
  });
});
