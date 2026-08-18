/**
 * ISS-5300 (PRD-618): `command-signing-keys-ipc.ts` was reached by no test.
 * Nine channels: six gated on `assertTrustedIpcSender`, three ungated.
 *
 * Sync gate failures surface as thrown errors (`assert.throws`).
 * `RevokeCommandSigningKey` is registered `async`, so its gate failure is a
 * rejected promise — use `assert.rejects`, NOT `assert.throws`, against it.
 *
 * This module is NOT one of the two registrars the docstring in
 * `desktop-ipc-registration.ts:231-236` blesses as deliberately ungated.
 * The three ungated read channels are tested for observable behaviour only;
 * this suite makes no claim that their missing gates are intentional.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { vi } from "vitest";
import type { AuthorizedCommandKeyStore } from "../src/main/command-signing/authorized-command-key-store.js";
import {
  CommandSigningKeysIpcChannel,
  type CommandSigningKeysState,
  registerCommandSigningKeysIpcHandlers,
} from "../src/main/ipc/command-signing-keys-ipc.js";
import {
  createIpcRegistrar,
  isTrustedSenderDouble,
  TRUSTED_EVENT,
  UNTRUSTED_EVENT,
  UNTRUSTED_SENDER_ERROR,
} from "./helpers/ipc-registrar.js";

// Module-level regex constants required by Biome's useTopLevelRegex rule.
const PUBLIC_KEY_REQUIRED_ERROR = /public key payload is required/;
const PUBLIC_KEY_BASE64_REQUIRED_ERROR = /publicKeyBase64 is required/;
const FINGERPRINT_REQUIRED_ERROR = /fingerprint is required/;

function makeState(
  overrides?: Partial<CommandSigningKeysState>
): CommandSigningKeysState {
  return {
    available: [],
    authorized: [],
    rejectedFingerprints: [],
    serverSupported: false,
    enforcementEnabled: false,
    ...overrides,
  };
}

/**
 * Builds a fresh harness + typed mock deps for each test so no state bleeds
 * between runs. Test code exemption: the partial mock object is cast to
 * `AuthorizedCommandKeyStore` — the multi-method store class is impractical
 * to construct in full here (AGENTS.md test-code exemption for `as unknown as`).
 */
function createHarness() {
  const state = makeState();
  const storeList = vi.fn((): unknown[] => []);
  const storeAuthorize = vi.fn((_input: unknown): void => {});
  const storeRemove = vi.fn((_fp: string): boolean => true);
  const authorizedCommandKeys = {
    list: storeList,
    authorize: storeAuthorize,
    remove: storeRemove,
  };
  const listCommandSigningKeys = vi.fn(
    async (): Promise<CommandSigningKeysState> => state
  );
  const notifyCommandKeysChanged = vi.fn((): void => {});
  const approveOrganizationCommandPublicKey = vi.fn(
    async (_fp: unknown): Promise<CommandSigningKeysState> => state
  );
  const rejectOrganizationCommandPublicKey = vi.fn(
    async (_fp: unknown): Promise<CommandSigningKeysState> => state
  );
  const harness = createIpcRegistrar();
  registerCommandSigningKeysIpcHandlers(harness.registrar, {
    isTrustedSender: isTrustedSenderDouble,
    // Test code exemption: partial fixture cast for multi-method store class.
    authorizedCommandKeys:
      authorizedCommandKeys as unknown as AuthorizedCommandKeyStore,
    listCommandSigningKeys,
    notifyCommandKeysChanged,
    approveOrganizationCommandPublicKey,
    rejectOrganizationCommandPublicKey,
  });
  return {
    harness,
    state,
    authorizedCommandKeys,
    listCommandSigningKeys,
    notifyCommandKeysChanged,
    approveOrganizationCommandPublicKey,
    rejectOrganizationCommandPublicKey,
  };
}

// ── Registration ────────────────────────────────────────────────────────────

describe("command-signing-keys IPC registration", () => {
  test("registers exactly the channels declared by CommandSigningKeysIpcChannel", () => {
    const { harness } = createHarness();
    assert.deepEqual(
      [...harness.channels()].sort(),
      Object.values(CommandSigningKeysIpcChannel).sort()
    );
  });
});

// ── ListCommandSigningKeys (ungated) ─────────────────────────────────────────

describe("ListCommandSigningKeys", () => {
  test("returns the result of listCommandSigningKeys", async () => {
    const { harness, listCommandSigningKeys, state } = createHarness();
    const result = await (harness.invoke(
      CommandSigningKeysIpcChannel.ListCommandSigningKeys,
      UNTRUSTED_EVENT
    ) as Promise<unknown>);
    assert.equal(listCommandSigningKeys.mock.calls.length, 1);
    assert.deepEqual(result, state);
  });
});

// ── ListAuthorizedKeys (ungated) ─────────────────────────────────────────────

describe("ListAuthorizedKeys", () => {
  test("returns the result of authorizedCommandKeys.list", () => {
    const { harness, authorizedCommandKeys } = createHarness();
    const result = harness.invoke(
      CommandSigningKeysIpcChannel.ListAuthorizedKeys,
      UNTRUSTED_EVENT
    );
    assert.equal(authorizedCommandKeys.list.mock.calls.length, 1);
    assert.deepEqual(result, []);
  });
});

// ── ListOrgPublicKeys (ungated, async) ───────────────────────────────────────

describe("ListOrgPublicKeys", () => {
  test("returns the available field extracted from listCommandSigningKeys state", async () => {
    const available = [
      {
        id: "key-1",
        userId: "u1",
        organizationId: "org1",
        publicKeyBase64: "abc",
        fingerprint: "fp1",
        createdAt: "2024-01-01T00:00:00.000Z",
        ownerName: "Alice",
      },
    ];
    const state = makeState({ available });
    const harness = createIpcRegistrar();
    const listCommandSigningKeys = vi.fn(
      async (): Promise<CommandSigningKeysState> => state
    );
    registerCommandSigningKeysIpcHandlers(harness.registrar, {
      isTrustedSender: isTrustedSenderDouble,
      authorizedCommandKeys: {
        list: vi.fn((): unknown[] => []),
        authorize: vi.fn((_i: unknown): void => {}),
        remove: vi.fn((_f: string): boolean => true),
      } as unknown as AuthorizedCommandKeyStore,
      listCommandSigningKeys,
      notifyCommandKeysChanged: vi.fn((): void => {}),
      approveOrganizationCommandPublicKey: vi.fn(
        async (_fp: unknown): Promise<CommandSigningKeysState> => state
      ),
      rejectOrganizationCommandPublicKey: vi.fn(
        async (_fp: unknown): Promise<CommandSigningKeysState> => state
      ),
    });

    const result = await (harness.invoke(
      CommandSigningKeysIpcChannel.ListOrgPublicKeys,
      UNTRUSTED_EVENT
    ) as Promise<unknown>);

    assert.deepEqual(result, available);
  });
});

// ── AuthorizeKey (gated) ─────────────────────────────────────────────────────

describe("AuthorizeKey — gate", () => {
  test("rejects an untrusted sender before authorizing", () => {
    const { harness, authorizedCommandKeys } = createHarness();
    assert.throws(
      () =>
        harness.invoke(
          CommandSigningKeysIpcChannel.AuthorizeKey,
          UNTRUSTED_EVENT,
          {
            publicKeyBase64: "any",
          }
        ),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(authorizedCommandKeys.authorize.mock.calls.length, 0);
  });
});

describe("AuthorizeKey — payload validation", () => {
  test("throws 'public key payload is required' when payload is null", () => {
    const { harness, authorizedCommandKeys } = createHarness();
    assert.throws(
      () =>
        harness.invoke(
          CommandSigningKeysIpcChannel.AuthorizeKey,
          TRUSTED_EVENT,
          null
        ),
      PUBLIC_KEY_REQUIRED_ERROR
    );
    assert.equal(authorizedCommandKeys.authorize.mock.calls.length, 0);
  });

  test("throws 'public key payload is required' when payload is an array", () => {
    // Covers the Array.isArray branch specifically (arrays are objects but gated separately).
    const { harness, authorizedCommandKeys } = createHarness();
    assert.throws(
      () =>
        harness.invoke(
          CommandSigningKeysIpcChannel.AuthorizeKey,
          TRUSTED_EVENT,
          ["entry"]
        ),
      PUBLIC_KEY_REQUIRED_ERROR
    );
    assert.equal(authorizedCommandKeys.authorize.mock.calls.length, 0);
  });

  test("throws 'publicKeyBase64 is required' when payload is an object but publicKeyBase64 is absent", () => {
    // Distinct throw from the payload-required path — asserted separately per obligation.
    const { harness, authorizedCommandKeys } = createHarness();
    assert.throws(
      () =>
        harness.invoke(
          CommandSigningKeysIpcChannel.AuthorizeKey,
          TRUSTED_EVENT,
          {
            label: "x",
          }
        ),
      PUBLIC_KEY_BASE64_REQUIRED_ERROR
    );
    assert.equal(authorizedCommandKeys.authorize.mock.calls.length, 0);
  });
});

// ── AuthorizeKey — resolveManualOwnerName 3-way precedence ───────────────────

describe("AuthorizeKey — resolveManualOwnerName precedence", () => {
  test("passes label as ownerName when both label and ownerName are present", () => {
    const { harness, authorizedCommandKeys } = createHarness();
    harness.invoke(CommandSigningKeysIpcChannel.AuthorizeKey, TRUSTED_EVENT, {
      publicKeyBase64: "dummy-key",
      label: "my-label",
      ownerName: "my-owner",
    });
    const arg = authorizedCommandKeys.authorize.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    assert.equal(arg.ownerName, "my-label");
  });

  test("passes ownerName when label is absent", () => {
    // No `label` field — explicitly absent to confirm ownerName is the fallback,
    // per AGENTS.md: clearing the higher-priority input is mandatory.
    const { harness, authorizedCommandKeys } = createHarness();
    harness.invoke(CommandSigningKeysIpcChannel.AuthorizeKey, TRUSTED_EVENT, {
      publicKeyBase64: "dummy-key",
      ownerName: "my-owner",
    });
    const arg = authorizedCommandKeys.authorize.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    assert.equal(arg.ownerName, "my-owner");
  });

  test("passes undefined ownerName when neither label nor ownerName is present", () => {
    // Neither field — both explicitly absent to test the undefined terminal branch.
    const { harness, authorizedCommandKeys } = createHarness();
    harness.invoke(CommandSigningKeysIpcChannel.AuthorizeKey, TRUSTED_EVENT, {
      publicKeyBase64: "dummy-key",
    });
    const arg = authorizedCommandKeys.authorize.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    assert.equal(arg.ownerName, undefined);
  });
});

describe("AuthorizeKey — happy path", () => {
  test("calls authorize, notifies, and returns the key list", () => {
    const keyList = [
      {
        fingerprint: "fp-1",
        publicKeyBase64: "k1",
        ownerName: "Alice",
        authorizedAt: "2024-01-01T00:00:00.000Z",
        source: "manual",
      },
    ];
    const harness = createIpcRegistrar();
    const storeList = vi.fn((): unknown[] => keyList);
    const storeAuthorize = vi.fn((_i: unknown): void => {});
    const notifyCommandKeysChanged = vi.fn((): void => {});
    const state = makeState();
    registerCommandSigningKeysIpcHandlers(harness.registrar, {
      isTrustedSender: isTrustedSenderDouble,
      authorizedCommandKeys: {
        list: storeList,
        authorize: storeAuthorize,
        remove: vi.fn((_f: string): boolean => true),
      } as unknown as AuthorizedCommandKeyStore,
      listCommandSigningKeys: vi.fn(
        async (): Promise<CommandSigningKeysState> => state
      ),
      notifyCommandKeysChanged,
      approveOrganizationCommandPublicKey: vi.fn(
        async (_fp: unknown): Promise<CommandSigningKeysState> => state
      ),
      rejectOrganizationCommandPublicKey: vi.fn(
        async (_fp: unknown): Promise<CommandSigningKeysState> => state
      ),
    });

    const result = harness.invoke(
      CommandSigningKeysIpcChannel.AuthorizeKey,
      TRUSTED_EVENT,
      { publicKeyBase64: "my-public-key" }
    );

    assert.equal(storeAuthorize.mock.calls.length, 1);
    // The full object passed to authorize must include source:"manual" and all
    // optional fields. Mutating source to "org-sync" in the source turns this RED.
    assert.deepEqual(storeAuthorize.mock.calls[0][0], {
      publicKeyBase64: "my-public-key",
      ownerName: undefined,
      ownerEmail: undefined,
      fingerprint: undefined,
      source: "manual",
    });
    assert.equal(notifyCommandKeysChanged.mock.calls.length, 1);
    assert.deepEqual(result, keyList);
  });

  test("passes ownerEmail and fingerprint through to authorize when provided", () => {
    const state = makeState();
    const storeAuthorize = vi.fn((_i: unknown): void => {});
    const harness = createIpcRegistrar();
    registerCommandSigningKeysIpcHandlers(harness.registrar, {
      isTrustedSender: isTrustedSenderDouble,
      authorizedCommandKeys: {
        list: vi.fn((): unknown[] => []),
        authorize: storeAuthorize,
        remove: vi.fn((_f: string): boolean => true),
      } as unknown as AuthorizedCommandKeyStore,
      listCommandSigningKeys: vi.fn(
        async (): Promise<CommandSigningKeysState> => state
      ),
      notifyCommandKeysChanged: vi.fn((): void => {}),
      approveOrganizationCommandPublicKey: vi.fn(
        async (_fp: unknown): Promise<CommandSigningKeysState> => state
      ),
      rejectOrganizationCommandPublicKey: vi.fn(
        async (_fp: unknown): Promise<CommandSigningKeysState> => state
      ),
    });

    harness.invoke(CommandSigningKeysIpcChannel.AuthorizeKey, TRUSTED_EVENT, {
      publicKeyBase64: "my-public-key",
      ownerEmail: "alice@example.com",
      fingerprint: "fp-explicit",
    });

    assert.deepEqual(storeAuthorize.mock.calls[0][0], {
      publicKeyBase64: "my-public-key",
      ownerName: undefined,
      ownerEmail: "alice@example.com",
      fingerprint: "fp-explicit",
      source: "manual",
    });
  });
});

// ── RemoveAuthorizedKey (gated) ──────────────────────────────────────────────

describe("RemoveAuthorizedKey — gate", () => {
  test("rejects an untrusted sender before removing", () => {
    const { harness, authorizedCommandKeys } = createHarness();
    assert.throws(
      () =>
        harness.invoke(
          CommandSigningKeysIpcChannel.RemoveAuthorizedKey,
          UNTRUSTED_EVENT,
          "fp-valid"
        ),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(authorizedCommandKeys.remove.mock.calls.length, 0);
  });
});

describe("RemoveAuthorizedKey — fingerprint validation", () => {
  test("throws when fingerprint is not a string", () => {
    const { harness, authorizedCommandKeys } = createHarness();
    assert.throws(
      () =>
        harness.invoke(
          CommandSigningKeysIpcChannel.RemoveAuthorizedKey,
          TRUSTED_EVENT,
          null
        ),
      FINGERPRINT_REQUIRED_ERROR
    );
    assert.equal(authorizedCommandKeys.remove.mock.calls.length, 0);
  });

  test("throws when fingerprint is whitespace-only", () => {
    const { harness, authorizedCommandKeys } = createHarness();
    assert.throws(
      () =>
        harness.invoke(
          CommandSigningKeysIpcChannel.RemoveAuthorizedKey,
          TRUSTED_EVENT,
          "   "
        ),
      FINGERPRINT_REQUIRED_ERROR
    );
    assert.equal(authorizedCommandKeys.remove.mock.calls.length, 0);
  });
});

describe("RemoveAuthorizedKey — behaviour", () => {
  test("removes the key, notifies, and returns the key list", () => {
    const { harness, authorizedCommandKeys, notifyCommandKeysChanged } =
      createHarness();
    const result = harness.invoke(
      CommandSigningKeysIpcChannel.RemoveAuthorizedKey,
      TRUSTED_EVENT,
      "fp-to-remove"
    );
    assert.equal(authorizedCommandKeys.remove.mock.calls.length, 1);
    assert.deepEqual(authorizedCommandKeys.remove.mock.calls[0], [
      "fp-to-remove",
    ]);
    assert.equal(notifyCommandKeysChanged.mock.calls.length, 1);
    assert.deepEqual(result, []);
  });

  // Pins a source inconsistency: RemoveAuthorizedKey passes raw fingerprint
  // (L114), while RevokeCommandSigningKey trims before remove() (L151).
  test("padded fingerprint reaches the store untrimmed (source defect)", () => {
    const { harness, authorizedCommandKeys } = createHarness();
    harness.invoke(
      CommandSigningKeysIpcChannel.RemoveAuthorizedKey,
      TRUSTED_EVENT,
      "  fp-padded  "
    );
    assert.equal(authorizedCommandKeys.remove.mock.calls.length, 1);
    assert.deepEqual(authorizedCommandKeys.remove.mock.calls[0], [
      "  fp-padded  ",
    ]);
  });
});

// ── ApproveOrgPublicKey (gated) ──────────────────────────────────────────────

describe("ApproveOrgPublicKey — gate", () => {
  test("rejects an untrusted sender before approving", () => {
    const { harness, approveOrganizationCommandPublicKey } = createHarness();
    assert.throws(
      () =>
        harness.invoke(
          CommandSigningKeysIpcChannel.ApproveOrgPublicKey,
          UNTRUSTED_EVENT,
          "fp"
        ),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(approveOrganizationCommandPublicKey.mock.calls.length, 0);
  });
});

describe("ApproveOrgPublicKey — behaviour", () => {
  test("delegates to approveOrganizationCommandPublicKey with the fingerprint", async () => {
    const { harness, approveOrganizationCommandPublicKey, state } =
      createHarness();
    const result = await (harness.invoke(
      CommandSigningKeysIpcChannel.ApproveOrgPublicKey,
      TRUSTED_EVENT,
      "fp-123"
    ) as Promise<unknown>);
    assert.equal(approveOrganizationCommandPublicKey.mock.calls.length, 1);
    assert.deepEqual(approveOrganizationCommandPublicKey.mock.calls[0], [
      "fp-123",
    ]);
    assert.deepEqual(result, state);
  });
});

// ── RejectOrgPublicKey (gated) ───────────────────────────────────────────────

describe("RejectOrgPublicKey — gate", () => {
  test("rejects an untrusted sender before rejecting", () => {
    const { harness, rejectOrganizationCommandPublicKey } = createHarness();
    assert.throws(
      () =>
        harness.invoke(
          CommandSigningKeysIpcChannel.RejectOrgPublicKey,
          UNTRUSTED_EVENT,
          "fp"
        ),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(rejectOrganizationCommandPublicKey.mock.calls.length, 0);
  });
});

describe("RejectOrgPublicKey — behaviour", () => {
  test("delegates to rejectOrganizationCommandPublicKey with the fingerprint", async () => {
    const { harness, rejectOrganizationCommandPublicKey, state } =
      createHarness();
    const result = await (harness.invoke(
      CommandSigningKeysIpcChannel.RejectOrgPublicKey,
      TRUSTED_EVENT,
      "fp-456"
    ) as Promise<unknown>);
    assert.equal(rejectOrganizationCommandPublicKey.mock.calls.length, 1);
    assert.deepEqual(rejectOrganizationCommandPublicKey.mock.calls[0], [
      "fp-456",
    ]);
    assert.deepEqual(result, state);
  });
});

// ── AuthorizeCommandSigningKey (gated) ───────────────────────────────────────

describe("AuthorizeCommandSigningKey — gate", () => {
  test("rejects an untrusted sender before approving", () => {
    const { harness, approveOrganizationCommandPublicKey } = createHarness();
    assert.throws(
      () =>
        harness.invoke(
          CommandSigningKeysIpcChannel.AuthorizeCommandSigningKey,
          UNTRUSTED_EVENT,
          "fp"
        ),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(approveOrganizationCommandPublicKey.mock.calls.length, 0);
  });
});

describe("AuthorizeCommandSigningKey — behaviour", () => {
  test("delegates to approveOrganizationCommandPublicKey with the fingerprint", async () => {
    const { harness, approveOrganizationCommandPublicKey, state } =
      createHarness();
    const result = await (harness.invoke(
      CommandSigningKeysIpcChannel.AuthorizeCommandSigningKey,
      TRUSTED_EVENT,
      "fp-789"
    ) as Promise<unknown>);
    assert.equal(approveOrganizationCommandPublicKey.mock.calls.length, 1);
    assert.deepEqual(approveOrganizationCommandPublicKey.mock.calls[0], [
      "fp-789",
    ]);
    assert.deepEqual(result, state);
  });
});

// ── RevokeCommandSigningKey (gated, async) ───────────────────────────────────

describe("RevokeCommandSigningKey — gate (async)", () => {
  test("rejects an untrusted sender before removing", async () => {
    const { harness, authorizedCommandKeys } = createHarness();
    await assert.rejects(
      () =>
        harness.invoke(
          CommandSigningKeysIpcChannel.RevokeCommandSigningKey,
          UNTRUSTED_EVENT,
          "fp"
        ) as Promise<unknown>,
      UNTRUSTED_SENDER_ERROR
    );
    // callCount() === 0 asserted AFTER the await, per briefing requirement.
    assert.equal(authorizedCommandKeys.remove.mock.calls.length, 0);
  });
});

describe("RevokeCommandSigningKey — fingerprint validation (async)", () => {
  test("rejects when fingerprint is not a string", async () => {
    const { harness, authorizedCommandKeys } = createHarness();
    await assert.rejects(
      () =>
        harness.invoke(
          CommandSigningKeysIpcChannel.RevokeCommandSigningKey,
          TRUSTED_EVENT,
          null
        ) as Promise<unknown>,
      FINGERPRINT_REQUIRED_ERROR
    );
    assert.equal(authorizedCommandKeys.remove.mock.calls.length, 0);
  });

  test("rejects when fingerprint is whitespace-only", async () => {
    const { harness, authorizedCommandKeys } = createHarness();
    await assert.rejects(
      () =>
        harness.invoke(
          CommandSigningKeysIpcChannel.RevokeCommandSigningKey,
          TRUSTED_EVENT,
          "   "
        ) as Promise<unknown>,
      FINGERPRINT_REQUIRED_ERROR
    );
    assert.equal(authorizedCommandKeys.remove.mock.calls.length, 0);
  });
});

describe("RevokeCommandSigningKey — ordering", () => {
  test("calls notifyCommandKeysChanged AFTER listCommandSigningKeys resolves", async () => {
    // Observable sequence proves the ordering in the production code at :152-153.
    // Inverting the order in production would produce ["notify","list"] and fail.
    const sequence: string[] = [];
    const state = makeState();
    const listCommandSigningKeys = vi.fn(
      async (): Promise<CommandSigningKeysState> => {
        await Promise.resolve();
        sequence.push("list");
        return state;
      }
    );
    const notifyCommandKeysChanged = vi.fn((): void => {
      sequence.push("notify");
    });
    const harness = createIpcRegistrar();
    registerCommandSigningKeysIpcHandlers(harness.registrar, {
      isTrustedSender: isTrustedSenderDouble,
      authorizedCommandKeys: {
        list: vi.fn((): unknown[] => []),
        authorize: vi.fn((_i: unknown): void => {}),
        remove: vi.fn((_f: string): boolean => true),
      } as unknown as AuthorizedCommandKeyStore,
      listCommandSigningKeys,
      notifyCommandKeysChanged,
      approveOrganizationCommandPublicKey: vi.fn(
        async (_fp: unknown): Promise<CommandSigningKeysState> => state
      ),
      rejectOrganizationCommandPublicKey: vi.fn(
        async (_fp: unknown): Promise<CommandSigningKeysState> => state
      ),
    });

    await (harness.invoke(
      CommandSigningKeysIpcChannel.RevokeCommandSigningKey,
      TRUSTED_EVENT,
      "fp-valid"
    ) as Promise<unknown>);

    assert.deepEqual(sequence, ["list", "notify"]);
  });
});

describe("RevokeCommandSigningKey — happy path", () => {
  test("removes the key and returns the post-revoke state", async () => {
    const { harness, authorizedCommandKeys, notifyCommandKeysChanged, state } =
      createHarness();
    const result = await (harness.invoke(
      CommandSigningKeysIpcChannel.RevokeCommandSigningKey,
      TRUSTED_EVENT,
      "fp-to-revoke"
    ) as Promise<unknown>);
    assert.equal(authorizedCommandKeys.remove.mock.calls.length, 1);
    assert.deepEqual(authorizedCommandKeys.remove.mock.calls[0], [
      "fp-to-revoke",
    ]);
    assert.equal(notifyCommandKeysChanged.mock.calls.length, 1);
    assert.deepEqual(result, state);
  });
});
