import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchRelayCommandToRelay: vi.fn(),
  logWarn: vi.fn(),
  desktopCreateCommand: vi.fn(),
  validateCommandPublicKeyRegistration: vi.fn(),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    warn: mocks.logWarn,
  },
}));

vi.mock("@/lib/desktop-command-store", () => ({
  desktopCommandStore: {
    createCommand: mocks.desktopCreateCommand,
  },
}));

vi.mock("@/lib/auth/command-signing-crypto", () => ({
  validateCommandPublicKeyRegistration:
    mocks.validateCommandPublicKeyRegistration,
}));

vi.mock(
  "@/app/compute-targets/relay-command-helpers",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@/app/compute-targets/relay-command-helpers")
      >();
    return {
      ...original,
      dispatchRelayCommandToRelay: mocks.dispatchRelayCommandToRelay,
    };
  }
);

import {
  BROWSER_KEY_APPROVAL_REQUEST_OPERATION_ID,
  BROWSER_KEY_APPROVAL_REQUEST_PATH,
  BROWSER_KEY_REVOCATION_OPERATION_ID,
  BROWSER_KEY_REVOCATION_PATH,
} from "@repo/api/src/types/compute-target";
import { publicKeysService } from "./service";

const createdAt = new Date("2026-05-08T22:00:00.000Z");

function installDb(db: unknown) {
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(db)
  );
}

describe("publicKeysService.listOrganizationPublicKeys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes active same-org keys for users who can use shared compute targets", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "key-1",
        userId: "viewer-1",
        organizationId: "org-1",
        publicKeyBase64: "public-key",
        fingerprint: "cl:abcdefghijklmnopqrstuv",
        createdAt,
        user: {
          email: "viewer@example.com",
          firstName: "Shared",
          lastName: "User",
        },
      },
    ]);
    installDb({
      userPublicKey: { findMany },
    });

    const result = await publicKeysService.listOrganizationPublicKeys("org-1");

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
          user: {
            active: true,
            OR: [
              {
                computeTargets: {
                  some: {
                    organizationId: "org-1",
                  },
                },
              },
              {
                organization: {
                  computeTargets: {
                    some: {
                      organizationId: "org-1",
                      isSharedWithOrg: true,
                    },
                  },
                },
              },
            ],
          },
        },
      })
    );
    expect(result).toEqual([
      {
        id: "key-1",
        userId: "viewer-1",
        organizationId: "org-1",
        publicKeyBase64: "public-key",
        fingerprint: "cl:abcdefghijklmnopqrstuv",
        createdAt: createdAt.toISOString(),
        ownerName: "Shared User",
        ownerEmail: "viewer@example.com",
      },
    ]);
  });
});

describe("publicKeysService.registerUserPublicKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateCommandPublicKeyRegistration.mockReturnValue({
      ok: true,
      fingerprint: "cl:abcdefghijklmnopqrstuv",
    });
  });

  it("dispatches an approval request to owned and org-shared online targets", async () => {
    const row = {
      id: "key-1",
      userId: "user-1",
      organizationId: "org-1",
      publicKeyBase64: "public-key",
      fingerprint: "cl:abcdefghijklmnopqrstuv",
      createdAt,
    };
    const upsert = vi.fn().mockResolvedValue(row);
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "owned-target",
        userId: "user-1",
        capabilities: {},
        isOnline: true,
        isSharedWithOrg: false,
      },
      {
        id: "shared-target",
        userId: "user-2",
        isOnline: true,
        isSharedWithOrg: true,
      },
    ]);
    installDb({
      userPublicKey: { upsert },
      computeTarget: { findMany },
    });
    mocks.desktopCreateCommand
      .mockResolvedValueOnce({ command: { commandId: "cmd-owned" } })
      .mockResolvedValueOnce({ command: { commandId: "cmd-shared" } });
    mocks.dispatchRelayCommandToRelay.mockResolvedValue({ delivered: true });

    const result = await publicKeysService.registerUserPublicKey({
      userId: "user-1",
      organizationId: "org-1",
      payload: {
        publicKeyBase64: " public-key ",
        fingerprint: "cl:abcdefghijklmnopqrstuv",
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        id: "key-1",
        userId: "user-1",
        organizationId: "org-1",
        publicKeyBase64: "public-key",
        fingerprint: "cl:abcdefghijklmnopqrstuv",
        createdAt: createdAt.toISOString(),
      },
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        isOnline: true,
        OR: [{ userId: "user-1" }, { isSharedWithOrg: true }],
      },
      select: {
        id: true,
        userId: true,
        isOnline: true,
        isSharedWithOrg: true,
      },
    });
    expect(mocks.desktopCreateCommand).toHaveBeenCalledTimes(2);
    expect(mocks.desktopCreateCommand).toHaveBeenNthCalledWith(
      1,
      "owned-target",
      expect.objectContaining({
        operationId: BROWSER_KEY_APPROVAL_REQUEST_OPERATION_ID,
        path: BROWSER_KEY_APPROVAL_REQUEST_PATH,
        body: {
          publicKeyId: "key-1",
          userId: "user-1",
          fingerprint: "cl:abcdefghijklmnopqrstuv",
        },
      })
    );
    expect(mocks.desktopCreateCommand).toHaveBeenNthCalledWith(
      2,
      "shared-target",
      expect.objectContaining({
        operationId: BROWSER_KEY_APPROVAL_REQUEST_OPERATION_ID,
        path: BROWSER_KEY_APPROVAL_REQUEST_PATH,
      })
    );
    expect(mocks.dispatchRelayCommandToRelay).toHaveBeenCalledTimes(2);
  });

  it("keeps registration successful when approval request relay delivery fails", async () => {
    const row = {
      id: "key-1",
      userId: "user-1",
      organizationId: "org-1",
      publicKeyBase64: "public-key",
      fingerprint: "cl:abcdefghijklmnopqrstuv",
      createdAt,
    };
    const upsert = vi.fn().mockResolvedValue(row);
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "owned-target",
        userId: "user-1",
        capabilities: {},
        isOnline: true,
        isSharedWithOrg: false,
      },
    ]);
    installDb({
      userPublicKey: { upsert },
      computeTarget: { findMany },
    });
    mocks.desktopCreateCommand.mockResolvedValue({
      command: { commandId: "cmd-owned" },
    });
    mocks.dispatchRelayCommandToRelay.mockResolvedValue({
      delivered: false,
      reason: "target_offline",
    });

    const result = await publicKeysService.registerUserPublicKey({
      userId: "user-1",
      organizationId: "org-1",
      payload: {
        publicKeyBase64: "public-key",
        fingerprint: "cl:abcdefghijklmnopqrstuv",
      },
    });

    expect(result.ok).toBe(true);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "browser_key_approval_request_not_delivered",
      expect.objectContaining({
        computeTargetId: "owned-target",
        commandId: "cmd-owned",
        reason: "target_offline",
      })
    );
  });
});

describe("publicKeysService.unregisterUserPublicKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes only the authenticated user's matching browser key", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: "key-1",
      userId: "user-1",
      organizationId: "org-1",
      publicKeyBase64: "public-key",
      fingerprint: "cl:abcdefghijklmnopqrstuv",
      createdAt,
    });
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({
      userPublicKey: { findFirst, deleteMany },
      computeTarget: { findMany },
    });

    const result = await publicKeysService.unregisterUserPublicKey({
      userId: "user-1",
      organizationId: "org-1",
      fingerprint: "cl:abcdefghijklmnopqrstuv",
    });

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        organizationId: "org-1",
        fingerprint: "cl:abcdefghijklmnopqrstuv",
      },
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        id: "key-1",
        userId: "user-1",
        organizationId: "org-1",
        fingerprint: "cl:abcdefghijklmnopqrstuv",
      },
    });
    expect(result).toEqual({ deleted: true });
  });

  it("treats missing browser keys as already unregistered", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const deleteMany = vi.fn();
    const findMany = vi.fn();
    installDb({
      userPublicKey: { findFirst, deleteMany },
      computeTarget: { findMany },
    });

    await expect(
      publicKeysService.unregisterUserPublicKey({
        userId: "user-1",
        organizationId: "org-1",
        fingerprint: "cl:abcdefghijklmnopqrstuv",
      })
    ).resolves.toEqual({ deleted: false });
    expect(deleteMany).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("notifies owned and org-shared online targets without requiring advertised revocation support", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: "key-1",
      userId: "user-1",
      organizationId: "org-1",
      publicKeyBase64: "public-key",
      fingerprint: "cl:abcdefghijklmnopqrstuv",
      createdAt,
    });
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "owned-supported",
        userId: "user-1",
        capabilities: {},
        supportedOperations: [BROWSER_KEY_REVOCATION_OPERATION_ID],
        isOnline: true,
        isSharedWithOrg: false,
      },
      {
        id: "shared-supported",
        userId: "user-2",
        supportedOperations: [BROWSER_KEY_REVOCATION_OPERATION_ID],
        isOnline: true,
        isSharedWithOrg: true,
      },
      {
        id: "owned-unsupported",
        userId: "user-1",
        capabilities: {},
        supportedOperations: ["symphony_chat"],
        isOnline: true,
        isSharedWithOrg: false,
      },
      {
        id: "shared-offline",
        userId: "user-2",
        capabilities: {},
        supportedOperations: [BROWSER_KEY_REVOCATION_OPERATION_ID],
        isOnline: false,
        isSharedWithOrg: true,
      },
      {
        id: "inaccessible-supported",
        userId: "user-2",
        capabilities: {},
        supportedOperations: [BROWSER_KEY_REVOCATION_OPERATION_ID],
        isOnline: true,
        isSharedWithOrg: false,
      },
    ]);
    installDb({
      userPublicKey: { findFirst, deleteMany },
      computeTarget: { findMany },
    });
    mocks.desktopCreateCommand
      .mockResolvedValueOnce({ command: { commandId: "cmd-owned" } })
      .mockResolvedValueOnce({ command: { commandId: "cmd-shared" } })
      .mockResolvedValueOnce({ command: { commandId: "cmd-unsupported" } });
    mocks.dispatchRelayCommandToRelay.mockResolvedValue({ delivered: true });

    const result = await publicKeysService.unregisterUserPublicKey({
      userId: "user-1",
      organizationId: "org-1",
      fingerprint: "cl:abcdefghijklmnopqrstuv",
    });

    expect(result).toEqual({ deleted: true });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        isOnline: true,
        OR: [{ userId: "user-1" }, { isSharedWithOrg: true }],
      },
      select: {
        id: true,
        userId: true,
        isOnline: true,
        isSharedWithOrg: true,
      },
    });
    expect(mocks.desktopCreateCommand).toHaveBeenCalledTimes(3);
    expect(mocks.desktopCreateCommand).toHaveBeenNthCalledWith(
      1,
      "owned-supported",
      expect.objectContaining({
        operationId: BROWSER_KEY_REVOCATION_OPERATION_ID,
        path: BROWSER_KEY_REVOCATION_PATH,
        body: {
          publicKeyId: "key-1",
          userId: "user-1",
          fingerprint: "cl:abcdefghijklmnopqrstuv",
        },
      })
    );
    expect(mocks.desktopCreateCommand).toHaveBeenNthCalledWith(
      2,
      "shared-supported",
      expect.objectContaining({
        operationId: BROWSER_KEY_REVOCATION_OPERATION_ID,
        path: BROWSER_KEY_REVOCATION_PATH,
      })
    );
    expect(mocks.desktopCreateCommand).toHaveBeenNthCalledWith(
      3,
      "owned-unsupported",
      expect.objectContaining({
        operationId: BROWSER_KEY_REVOCATION_OPERATION_ID,
        path: BROWSER_KEY_REVOCATION_PATH,
      })
    );
    expect(mocks.dispatchRelayCommandToRelay).toHaveBeenCalledTimes(3);
  });

  it("keeps unregister successful when revocation relay delivery fails", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: "key-1",
      userId: "user-1",
      organizationId: "org-1",
      publicKeyBase64: "public-key",
      fingerprint: "cl:abcdefghijklmnopqrstuv",
      createdAt,
    });
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "owned-supported",
        userId: "user-1",
        capabilities: {},
        supportedOperations: [BROWSER_KEY_REVOCATION_OPERATION_ID],
        isOnline: true,
        isSharedWithOrg: false,
      },
    ]);
    installDb({
      userPublicKey: { findFirst, deleteMany },
      computeTarget: { findMany },
    });
    mocks.desktopCreateCommand.mockResolvedValue({
      command: { commandId: "cmd-owned" },
    });
    mocks.dispatchRelayCommandToRelay.mockResolvedValue({
      delivered: false,
      reason: "target_offline",
    });

    await expect(
      publicKeysService.unregisterUserPublicKey({
        userId: "user-1",
        organizationId: "org-1",
        fingerprint: "cl:abcdefghijklmnopqrstuv",
      })
    ).resolves.toEqual({ deleted: true });

    expect(mocks.logWarn).toHaveBeenCalledWith(
      "browser_key_revocation_not_delivered",
      expect.objectContaining({
        computeTargetId: "owned-supported",
        commandId: "cmd-owned",
        reason: "target_offline",
      })
    );
  });
});
