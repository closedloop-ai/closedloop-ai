/**
 * @file command-signing-controller.test.ts
 * @description Unit tests for `CommandSigningController`
 * (src/main/command-signing/command-signing-controller.ts), the browser-command-
 * signing key manager extracted from `DesktopApplication` in PLN-1359 Phase 3.
 * These tests exercise the controller's ORCHESTRATION with fake collaborators:
 * settings navigation, renderer notifications, available/authorized/rejected key
 * classification + filtering, the pending-key notifications, and the
 * approve/reject organization-key flows (validation + the authorize → consume →
 * dismiss → notify sequence). The collaborators it composes each have their own
 * tests (authorized-command-key-store, command-signature-verifier, etc.).
 *
 * Collaborators are lightweight `mock.fn()` fakes cast to their concrete dep
 * types via the whole-bag `as unknown as CommandSigningControllerDeps` cast — an
 * established pattern in these desktop tests — so behavior and call arguments can
 * be controlled and asserted directly. Keeping `apiKeyStore.getApiKey()` null in
 * the approve flow keeps the private `fetchAvailableCommandSigningKeys()` offline
 * (it returns [] before any network call); the faked lifecycle selection is the
 * collaborator boundary that resolves the key.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { vi } from "vitest";
import type { OrganizationCommandPublicKey } from "../src/main/command-signing/authorized-public-keys-client.js";
import {
  CommandSigningController,
  type CommandSigningControllerDeps,
} from "../src/main/command-signing/command-signing-controller.js";

const FINGERPRINT_REQUIRED = /fingerprint is required/;
const KEY_NOT_FOUND = /Command signing key not found/;

function makeOrgKey(
  overrides: Partial<OrganizationCommandPublicKey> = {}
): OrganizationCommandPublicKey {
  return {
    userId: "user-1",
    organizationId: "org-1",
    publicKeyBase64: "cHVibGljLWtleQ==",
    fingerprint: "cl:orgkey00000000000000",
    createdAt: "2026-01-01T00:00:00.000Z",
    ownerName: "Org Owner",
    ...overrides,
  };
}

type ControllerOptions = {
  serverSupported?: boolean;
  enforcement?: boolean;
  apiKey?: string | null;
  authorizedFingerprints?: string[];
  rejectedFingerprints?: string[];
  notificationKeys?: OrganizationCommandPublicKey[];
  classificationImpl?: () => Promise<unknown>;
  selectedKey?: OrganizationCommandPublicKey | null;
};

function makeController(options: ControllerOptions = {}) {
  const serverSupported = options.serverSupported ?? true;
  const enforcement = options.enforcement ?? false;
  const apiKey = options.apiKey ?? null;
  const authorized = (options.authorizedFingerprints ?? []).map(
    (fingerprint) => ({ fingerprint })
  );
  const rejected = options.rejectedFingerprints ?? [];
  const notificationKeys = options.notificationKeys ?? [];

  const authorizedCommandKeys = {
    list: vi.fn(() => authorized),
    listRejectedFingerprints: vi.fn(() => [...rejected]),
    authorize: vi.fn((_input: Record<string, unknown>) => undefined),
    reject: vi.fn((_fingerprint: string) => undefined),
  };
  const commandKeyLifecycle = {
    getActiveTargetContext: vi.fn(() => ({ computeTargetId: "target-1" })),
    fetchOrganizationKeyClassification: vi.fn(
      (_input: {
        reason: string;
        fetchAvailableCommandSigningKeys: unknown;
      }): Promise<unknown> =>
        options.classificationImpl
          ? options.classificationImpl()
          : Promise.resolve({ notificationKeys })
    ),
    selectOrganizationCommandKeyForManualApproval: vi.fn(
      () => options.selectedKey ?? null
    ),
    consumeLegacyContextlessApproval: vi.fn(
      (_fingerprint: string) => undefined
    ),
  };
  const pendingCommandKeyNotifier = {
    notifyPendingKeys: vi.fn(
      (_keys: unknown): Promise<void> => Promise.resolve()
    ),
    dismiss: vi.fn((_fingerprint: string) => undefined),
  };
  const apiKeyStore = {
    getApiKey: vi.fn(() => apiKey),
    getApiKeyProvenance: vi.fn(() => "USER_CREATED" as const),
  };
  const settingsStore = {
    getApiOrigin: vi.fn(() => "https://api.test"),
    getCommandSigningEnforcementEnabled: vi.fn(() => enforcement),
  };
  const desktopWindow = {
    show: vi.fn(),
    sendToRenderer: vi.fn((..._args: unknown[]) => undefined),
  };
  const isServerCommandSigningSupported = vi.fn(() => serverSupported);
  const signDesktopRequest = vi.fn(() => null);
  const reportDesktopPopUnavailable = vi.fn();

  const deps = {
    authorizedCommandKeys,
    commandKeyLifecycle,
    pendingCommandKeyNotifier,
    apiKeyStore,
    settingsStore,
    desktopWindow,
    isServerCommandSigningSupported,
    signDesktopRequest,
    reportDesktopPopUnavailable,
  };
  const controller = new CommandSigningController(
    deps as unknown as CommandSigningControllerDeps
  );
  return { controller, ...deps };
}

describe("CommandSigningController renderer navigation", () => {
  test("openBrowserCommandKeysSettings shows the window and navigates to Security", () => {
    const h = makeController();
    h.controller.openBrowserCommandKeysSettings();
    assert.equal(h.desktopWindow.show.mock.calls.length, 1);
    assert.deepEqual(h.desktopWindow.sendToRenderer.mock.calls, [
      ["desktop:navigate-tab", "settings"],
      ["desktop:navigate-settings-tab", "security"],
    ]);
  });

  test("notifyCommandKeysChanged emits the renderer change event", () => {
    const h = makeController();
    h.controller.notifyCommandKeysChanged();
    assert.deepEqual(h.desktopWindow.sendToRenderer.mock.calls[0], [
      "desktop:command-keys-changed",
    ]);
  });
});

describe("CommandSigningController.listCommandSigningKeys", () => {
  test("short-circuits when server command-signing is unsupported", async () => {
    const h = makeController({ serverSupported: false, enforcement: true });
    const state = await h.controller.listCommandSigningKeys();
    assert.deepEqual(state, {
      available: [],
      authorized: [],
      rejectedFingerprints: [],
      serverSupported: false,
      enforcementEnabled: true,
    });
    assert.equal(
      h.commandKeyLifecycle.fetchOrganizationKeyClassification.mock.calls
        .length,
      0,
      "must not fetch classification when unsupported"
    );
  });

  test("filters authorized and rejected keys out of the available set", async () => {
    const authorizedKey = makeOrgKey({ fingerprint: "cl:authorized000000000" });
    const rejectedKey = makeOrgKey({ fingerprint: "cl:rejected0000000000000" });
    const freshKey = makeOrgKey({ fingerprint: "cl:fresh000000000000000" });
    const h = makeController({
      authorizedFingerprints: ["cl:authorized000000000"],
      rejectedFingerprints: ["cl:rejected0000000000000"],
      notificationKeys: [authorizedKey, rejectedKey, freshKey],
      enforcement: true,
    });
    const state = await h.controller.listCommandSigningKeys();
    assert.deepEqual(state.available, [freshKey]);
    assert.deepEqual(state.rejectedFingerprints, ["cl:rejected0000000000000"]);
    assert.equal(state.serverSupported, true);
    assert.equal(state.enforcementEnabled, true);
  });

  test("captures availableError and empties available when classification fails", async () => {
    const h = makeController({
      classificationImpl: () => Promise.reject(new Error("network down")),
    });
    const state = await h.controller.listCommandSigningKeys();
    assert.deepEqual(state.available, []);
    assert.equal(state.availableError, "network down");
    assert.equal(state.serverSupported, true);
  });
});

describe("CommandSigningController pending-key notifications", () => {
  test("getPendingCommandSigningKeysForNotification returns [] without an API key", async () => {
    const h = makeController({ apiKey: null });
    const result =
      await h.controller.getPendingCommandSigningKeysForNotification();
    assert.deepEqual(result, []);
  });

  test("getPendingCommandSigningKeysForNotification returns [] on availableError", async () => {
    const h = makeController({
      apiKey: "sk_live_x",
      classificationImpl: () => Promise.reject(new Error("boom")),
    });
    const result =
      await h.controller.getPendingCommandSigningKeysForNotification();
    assert.deepEqual(result, []);
  });

  test("getPendingCommandSigningKeysForNotification returns the available keys", async () => {
    const fresh = makeOrgKey({ fingerprint: "cl:fresh000000000000000" });
    const h = makeController({
      apiKey: "sk_live_x",
      notificationKeys: [fresh],
    });
    const result =
      await h.controller.getPendingCommandSigningKeysForNotification();
    assert.deepEqual(result, [fresh]);
  });

  test("notifyPendingCommandSigningKeysForOrganizationKeys notifies only unauthorized/unrejected keys", async () => {
    const authorizedKey = makeOrgKey({ fingerprint: "cl:authorized000000000" });
    const rejectedKey = makeOrgKey({ fingerprint: "cl:rejected0000000000000" });
    const freshKey = makeOrgKey({ fingerprint: "cl:fresh000000000000000" });
    const h = makeController({
      authorizedFingerprints: ["cl:authorized000000000"],
      rejectedFingerprints: ["cl:rejected0000000000000"],
    });
    await h.controller.notifyPendingCommandSigningKeysForOrganizationKeys([
      authorizedKey,
      rejectedKey,
      freshKey,
    ]);
    assert.equal(
      h.pendingCommandKeyNotifier.notifyPendingKeys.mock.calls.length,
      1
    );
    assert.deepEqual(
      h.pendingCommandKeyNotifier.notifyPendingKeys.mock.calls[0][0],
      [freshKey]
    );
  });

  test("notifyPendingCommandSigningKeyByFingerprint raises a synthetic pending entry", async () => {
    const h = makeController();
    await h.controller.notifyPendingCommandSigningKeyByFingerprint(
      "cl:abc00000000000000000"
    );
    assert.deepEqual(
      h.pendingCommandKeyNotifier.notifyPendingKeys.mock.calls[0][0],
      [
        {
          fingerprint: "cl:abc00000000000000000",
          ownerName: "A browser session",
        },
      ]
    );
  });
});

describe("CommandSigningController.approveOrganizationCommandPublicKey", () => {
  test("rejects a blank fingerprint", async () => {
    const h = makeController();
    await assert.rejects(
      h.controller.approveOrganizationCommandPublicKey("   "),
      FINGERPRINT_REQUIRED
    );
  });

  test("rejects a non-string fingerprint", async () => {
    const h = makeController();
    await assert.rejects(
      h.controller.approveOrganizationCommandPublicKey(42),
      FINGERPRINT_REQUIRED
    );
  });

  test("throws when no matching key is selected", async () => {
    const h = makeController({ selectedKey: null });
    await assert.rejects(
      h.controller.approveOrganizationCommandPublicKey(
        "cl:missing0000000000000"
      ),
      KEY_NOT_FOUND
    );
    assert.equal(h.authorizedCommandKeys.authorize.mock.calls.length, 0);
  });

  test("authorizes, consumes, dismisses, and notifies on success", async () => {
    const selected = makeOrgKey({
      fingerprint: "cl:selected000000000000",
      publicKeyBase64: "c2VsZWN0ZWQ=",
      ownerEmail: "owner@example.com",
      id: "pubkey-id-1",
    });
    const h = makeController({ selectedKey: selected });
    const state = await h.controller.approveOrganizationCommandPublicKey(
      "  cl:selected000000000000  "
    );

    assert.deepEqual(h.authorizedCommandKeys.authorize.mock.calls[0][0], {
      fingerprint: "cl:selected000000000000",
      publicKeyBase64: "c2VsZWN0ZWQ=",
      ownerName: "owner@example.com",
      ownerEmail: "owner@example.com",
      source: "org",
      sourceUserPublicKeyId: "pubkey-id-1",
    });
    assert.deepEqual(
      h.commandKeyLifecycle.consumeLegacyContextlessApproval.mock.calls[0],
      ["cl:selected000000000000"]
    );
    assert.deepEqual(h.pendingCommandKeyNotifier.dismiss.mock.calls[0], [
      "cl:selected000000000000",
    ]);
    assert.ok(
      h.desktopWindow.sendToRenderer.mock.calls.some(
        (c) => c[0] === "desktop:command-keys-changed"
      ),
      "renderer is notified of the key change"
    );
    assert.equal(state.serverSupported, true);
  });
});

describe("CommandSigningController.rejectOrganizationCommandPublicKey", () => {
  test("rejects a blank fingerprint", async () => {
    const h = makeController();
    await assert.rejects(
      h.controller.rejectOrganizationCommandPublicKey(""),
      FINGERPRINT_REQUIRED
    );
  });

  test("rejects the (trimmed) fingerprint, consumes, dismisses, and notifies", async () => {
    const h = makeController();
    const state = await h.controller.rejectOrganizationCommandPublicKey(
      "  cl:toreject00000000000  "
    );
    assert.deepEqual(h.authorizedCommandKeys.reject.mock.calls[0], [
      "cl:toreject00000000000",
    ]);
    assert.deepEqual(
      h.commandKeyLifecycle.consumeLegacyContextlessApproval.mock.calls[0],
      ["cl:toreject00000000000"]
    );
    assert.deepEqual(h.pendingCommandKeyNotifier.dismiss.mock.calls[0], [
      "cl:toreject00000000000",
    ]);
    assert.ok(
      h.desktopWindow.sendToRenderer.mock.calls.some(
        (c) => c[0] === "desktop:command-keys-changed"
      )
    );
    assert.equal(state.serverSupported, true);
  });
});

describe("CommandSigningController.fetchOrganizationCommandKeyClassification", () => {
  test("delegates to the lifecycle with the reason and a fetch callback", async () => {
    const h = makeController();
    await h.controller.fetchOrganizationCommandKeyClassification("manual");
    const call =
      h.commandKeyLifecycle.fetchOrganizationKeyClassification.mock.calls[0];
    assert.equal(call[0].reason, "manual");
    assert.equal(typeof call[0].fetchAvailableCommandSigningKeys, "function");
  });
});
