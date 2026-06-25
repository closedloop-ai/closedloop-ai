import { BROWSER_KEY_UNREGISTERED_ERROR_CODE } from "@repo/api/src/types/compute-target";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

import {
  browserKeyUnregisteredResponse,
  isRegisteredBrowserPublicKeyForRequester,
} from "./browser-command-public-key-enforcement";

function installDb(db: unknown) {
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(db)
  );
}

describe("browser command public-key enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts only keys registered to the requester in the same organization", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "key-1" });
    installDb({
      userPublicKey: { findFirst },
    });

    await expect(
      isRegisteredBrowserPublicKeyForRequester({
        userId: "user-1",
        organizationId: "org-1",
        publicKeyFingerprint: "cl:abcdefghijklmnopqrstuv",
      })
    ).resolves.toBe(true);

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        organizationId: "org-1",
        fingerprint: "cl:abcdefghijklmnopqrstuv",
      },
      select: { id: true },
    });
  });

  it("treats absent or cross-owner keys as unregistered", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    installDb({
      userPublicKey: { findFirst },
    });

    await expect(
      isRegisteredBrowserPublicKeyForRequester({
        userId: "user-1",
        organizationId: "org-1",
        publicKeyFingerprint: "cl:abcdefghijklmnopqrstuv",
      })
    ).resolves.toBe(false);
  });

  it("uses the browser_key_unregistered API response contract", async () => {
    const response = browserKeyUnregisteredResponse();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: BROWSER_KEY_UNREGISTERED_ERROR_CODE,
      code: BROWSER_KEY_UNREGISTERED_ERROR_CODE,
    });
  });
});
