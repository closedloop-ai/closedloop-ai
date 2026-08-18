import assert from "node:assert/strict";
import { test } from "node:test";
import type { CostReconciliationService } from "../src/main/cost/cost-reconciliation-service.js";
import {
  ApiKeyIpcChannel,
  registerApiKeyIpcHandlers,
} from "../src/main/ipc/api-key-ipc.js";
import type {
  ApiKeyStatus,
  ApiKeyStore,
} from "../src/main/settings/api-key-store.js";

type IpcHandler = (event: unknown, payload?: unknown) => unknown;

const TRUSTED_EVENT = { sender: "trusted" };
const MANUAL_ENTRY_DISABLED_ERROR = /Manual API key entry is disabled/;

const NO_KEY_STATUS: ApiKeyStatus = { hasApiKey: false, source: "none" };

function createApiKeyStoreStub(): {
  store: ApiKeyStore;
  calls: { setApiKey: string[] };
} {
  const calls = { setApiKey: [] as string[] };
  const store = {
    setApiKey: (apiKey: string) => {
      calls.setApiKey.push(apiKey);
    },
    getStatus: () => NO_KEY_STATUS,
    clearApiKey: () => undefined,
  } as unknown as ApiKeyStore;
  return { store, calls };
}

function register(options: { isManualApiKeyEntryDisabled: () => boolean }): {
  handlers: Map<string, IpcHandler>;
  calls: { setApiKey: string[] };
  sideEffects: { cancelled: number; warmed: number; restarted: number };
} {
  const { store, calls } = createApiKeyStoreStub();
  const handlers = new Map<string, IpcHandler>();
  const sideEffects = { cancelled: 0, warmed: 0, restarted: 0 };

  registerApiKeyIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    {
      isTrustedSender: () => true,
      apiKeyStore: store,
      costReconciliation: {
        getAdminKeyStatuses: () => [],
        setAdminKey: () => undefined,
        clearAdminKey: () => undefined,
      } as unknown as CostReconciliationService,
      cancelManagedOnboardingForUserChange: () => {
        sideEffects.cancelled += 1;
      },
      warmTelemetryOrgIdentity: () => {
        sideEffects.warmed += 1;
      },
      restartCloudSocket: () => {
        sideEffects.restarted += 1;
      },
      onApiKeyChanged: () => undefined,
      isManualApiKeyEntryDisabled: options.isManualApiKeyEntryDisabled,
    }
  );
  return { handlers, calls, sideEffects };
}

test("flag OFF: set-api-key stores the pasted key (paste path unchanged)", () => {
  const { handlers, calls, sideEffects } = register({
    isManualApiKeyEntryDisabled: () => false,
  });

  const result = handlers.get(ApiKeyIpcChannel.SetApiKey)?.(
    TRUSTED_EVENT,
    "sk_live_pasted"
  );

  assert.deepEqual(result, NO_KEY_STATUS);
  assert.deepEqual(calls.setApiKey, ["sk_live_pasted"]);
  assert.equal(sideEffects.cancelled, 1);
  assert.equal(sideEffects.warmed, 1);
  assert.equal(sideEffects.restarted, 1);
});

test("flag ON: set-api-key is rejected and never touches the store (paste path retired)", () => {
  const { handlers, calls, sideEffects } = register({
    isManualApiKeyEntryDisabled: () => true,
  });

  assert.throws(
    () =>
      handlers.get(ApiKeyIpcChannel.SetApiKey)?.(
        TRUSTED_EVENT,
        "sk_live_pasted"
      ),
    MANUAL_ENTRY_DISABLED_ERROR
  );
  // Fails closed before any credential mutation or side effect.
  assert.deepEqual(calls.setApiKey, []);
  assert.equal(sideEffects.cancelled, 0);
  assert.equal(sideEffects.warmed, 0);
  assert.equal(sideEffects.restarted, 0);
});

test("flag ON: clear-api-key still works (only the paste-set path is retired)", () => {
  const { handlers } = register({
    isManualApiKeyEntryDisabled: () => true,
  });

  const result = handlers.get(ApiKeyIpcChannel.ClearApiKey)?.(TRUSTED_EVENT);
  assert.deepEqual(result, NO_KEY_STATUS);
});

// PRD-532 §5.5 (PR-K / M8): the manual-entry gate is `flag ON AND a
// DESKTOP_MANAGED key is actually held`. Auto-provisioning treats failure /
// pop_unavailable as non-fatal, so a flag-ON install whose provisioning has not
// (yet) produced a managed key must keep the paste path as the fallback —
// otherwise a transient PoP/API failure locks a keyless install out. These
// cases mirror the `app.ts` predicate that feeds `isManualApiKeyEntryDisabled`.
type ApiKeyProvenance = "USER_CREATED" | "DESKTOP_MANAGED";
function manualEntryDisabled(
  flagOn: boolean,
  provenance: ApiKeyProvenance | null
): boolean {
  return flagOn && provenance === "DESKTOP_MANAGED";
}

test("flag ON but provisioning failed (no managed key): manual entry stays available", () => {
  // provenance === null models a keyless install after a failed / pop_unavailable
  // auto-provision — the fallback paste path must remain usable.
  const disabled = manualEntryDisabled(true, null);
  assert.equal(disabled, false);

  const { handlers, calls } = register({
    isManualApiKeyEntryDisabled: () => disabled,
  });
  const result = handlers.get(ApiKeyIpcChannel.SetApiKey)?.(
    TRUSTED_EVENT,
    "sk_live_fallback"
  );
  assert.deepEqual(result, NO_KEY_STATUS);
  assert.deepEqual(calls.setApiKey, ["sk_live_fallback"]);
});

test("flag ON with a DESKTOP_MANAGED key held: manual entry is disabled", () => {
  assert.equal(manualEntryDisabled(true, "DESKTOP_MANAGED"), true);

  const { handlers, calls } = register({
    isManualApiKeyEntryDisabled: () =>
      manualEntryDisabled(true, "DESKTOP_MANAGED"),
  });
  assert.throws(
    () =>
      handlers.get(ApiKeyIpcChannel.SetApiKey)?.(
        TRUSTED_EVENT,
        "sk_live_pasted"
      ),
    MANUAL_ENTRY_DISABLED_ERROR
  );
  assert.deepEqual(calls.setApiKey, []);
});

test("flag OFF: manual entry always available regardless of provenance", () => {
  assert.equal(manualEntryDisabled(false, "DESKTOP_MANAGED"), false);
  assert.equal(manualEntryDisabled(false, null), false);
});
