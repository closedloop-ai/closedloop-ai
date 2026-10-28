/**
 * ISS-11681: the Settings -> Connection Status verdict as the PRODUCTION path
 * computes it, through `DesktopCredentialStoreAdapter`.
 *
 * `connection-security-status.test.ts` pins the pure decision's rung order;
 * this suite pins what the adapter that `runtime-info-ipc` and the PoP
 * readiness read actually returns, so the adapter cannot drift from that
 * decision again. Each case supplies an input that would satisfy a later rung,
 * and the signing store is asserted untouched for the rungs that must not pay
 * for a key load.
 */
import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import type {
  GatewaySigningKeyResult,
  GatewaySigningKeyStore,
} from "../src/main/command-signing/gateway-signing-key-store.js";
import { DesktopCredentialStoreAdapter } from "../src/main/session/desktop-credential-store-adapter.js";
import type {
  ApiKeyStatus,
  ApiKeyStore,
} from "../src/main/settings/api-key-store.js";
import type { SettingsStore } from "../src/main/settings/settings-store.js";
import {
  ConnectionSecurityMode,
  type ConnectionSecurityStatus,
} from "../src/shared/connection-security.js";

const ACTIVE_GATEWAY_ID = "gateway-active";

const LOADABLE_KEY: GatewaySigningKeyResult = {
  ok: true,
  keyPair: {
    gatewayId: ACTIVE_GATEWAY_ID,
    privateKeyPkcs8Pem: "private-pem",
    publicKeySpkiPem: "public-pem",
  },
};

const UNLOADABLE_KEY: GatewaySigningKeyResult = {
  ok: false,
  reason: "decrypt_failed",
};

/** Returns the adapter's verdict plus the signing store's `load` spy. */
function verdictFor(
  apiKeyStatus: ApiKeyStatus,
  signingKey: GatewaySigningKeyResult
): {
  status: ConnectionSecurityStatus;
  load: ReturnType<typeof vi.fn>;
} {
  const load = vi.fn((_gatewayId: string) => signingKey);
  const adapter = new DesktopCredentialStoreAdapter({
    settingsStore: {} as unknown as SettingsStore,
    apiKeyStore: {
      getStatus: () => apiKeyStatus,
    } as unknown as ApiKeyStore,
    gatewaySigningKeyStore: { load } as unknown as GatewaySigningKeyStore,
    getActiveGatewayId: () => ACTIVE_GATEWAY_ID,
    getDesktopVersion: () => "0.0.0-test",
    getMachineName: () => "test-machine",
    getPlatform: () => "darwin",
  });
  return { status: adapter.getConnectionSecurityStatus(), load };
}

describe("DesktopCredentialStoreAdapter.getConnectionSecurityStatus", () => {
  it("reports unconfigured without loading a key, even with a managed provenance", () => {
    const { status, load } = verdictFor(
      { hasApiKey: false, source: "none", provenance: "DESKTOP_MANAGED" },
      LOADABLE_KEY
    );

    assert.deepEqual(status, {
      mode: ConnectionSecurityMode.Unconfigured,
      detail: "No cloud API key is configured.",
    });
    assert.equal(load.mock.calls.length, 0);
  });

  it("reports standard without loading a key for a user-created key", () => {
    const { status, load } = verdictFor(
      { hasApiKey: true, source: "safeStorage", provenance: "USER_CREATED" },
      LOADABLE_KEY
    );

    assert.deepEqual(status, {
      mode: ConnectionSecurityMode.Standard,
      detail: "Using a manually configured bearer key.",
    });
    assert.equal(load.mock.calls.length, 0);
  });

  it("reports standard, not enhanced, when the provenance is absent", () => {
    const { status, load } = verdictFor(
      { hasApiKey: true, source: "environment" },
      LOADABLE_KEY
    );

    assert.deepEqual(status, {
      mode: ConnectionSecurityMode.Standard,
      detail: "Using a manually configured bearer key.",
    });
    assert.equal(load.mock.calls.length, 0);
  });

  it("reports enhanced for a managed key whose active signing key loads", () => {
    const { status, load } = verdictFor(
      { hasApiKey: true, source: "safeStorage", provenance: "DESKTOP_MANAGED" },
      LOADABLE_KEY
    );

    assert.deepEqual(status, {
      mode: ConnectionSecurityMode.Enhanced,
      detail: "Managed key with request signing is configured.",
    });
    assert.deepEqual(load.mock.calls, [[ACTIVE_GATEWAY_ID]]);
  });

  it("reports signing unavailable for a managed key whose signing key does not load", () => {
    const { status, load } = verdictFor(
      { hasApiKey: true, source: "safeStorage", provenance: "DESKTOP_MANAGED" },
      UNLOADABLE_KEY
    );

    assert.deepEqual(status, {
      mode: ConnectionSecurityMode.SigningUnavailable,
      detail: "Managed key is present but request signing is unavailable.",
    });
    assert.deepEqual(load.mock.calls, [[ACTIVE_GATEWAY_ID]]);
  });
});
