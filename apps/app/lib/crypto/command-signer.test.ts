import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasEffectiveCommandSigningSupport,
  hashCommandBody,
  resolveSignedDesktopRequest,
  signDesktopCommand,
} from "./command-signer";

const keyStoreMocks = vi.hoisted(() => ({
  getOrCreateBrowserSigningKey: vi.fn(),
  getStoredBrowserSigningKey: vi.fn(),
}));

vi.mock("./key-store", () => keyStoreMocks);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("command signer support checks", () => {
  it("requires both local Desktop and explicit server command-signing support", () => {
    expect(
      hasEffectiveCommandSigningSupport({
        capabilities: { commandSigning: true },
        serverCapabilities: { computeTargetSigning: true },
      })
    ).toBe(true);
    expect(
      hasEffectiveCommandSigningSupport({
        capabilities: { commandSigning: true },
        serverCapabilities: {},
      })
    ).toBe(false);
    expect(
      hasEffectiveCommandSigningSupport({
        capabilities: {},
        serverCapabilities: { computeTargetSigning: true },
      })
    ).toBe(false);
  });
});

describe("resolveSignedDesktopRequest", () => {
  it("preserves query values in the canonical payload while splitting relay query", () => {
    const resolved = resolveSignedDesktopRequest(
      "/api/gateway/git?repo=%2Ftmp%2Frepo&mode=status&repo=%2Fother",
      {}
    );

    expect(resolved.path).toBe("/api/gateway/git");
    expect(resolved.query).toEqual({
      repo: ["/tmp/repo", "/other"],
      mode: "status",
    });
    expect(resolved.canonicalQuery).toEqual([
      ["mode", "status"],
      ["repo", "/other"],
      ["repo", "/tmp/repo"],
    ]);
  });
});

describe("hashCommandBody", () => {
  it("uses stable object ordering so signed body hashes are deterministic", async () => {
    await expect(hashCommandBody({ b: 2, a: 1 })).resolves.toBe(
      await hashCommandBody({ a: 1, b: 2 })
    );
  });
});

describe("signDesktopCommand", () => {
  it("signs with an existing stored browser key without creating a new key", async () => {
    const keyPair = (await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    keyStoreMocks.getStoredBrowserSigningKey.mockResolvedValue({
      ok: true,
      keyPair,
      publicKeyBase64: "registered-public-key",
      fingerprint: "cl:registeredBrowserKey",
    });

    const signed = await signDesktopCommand(
      {
        method: "post",
        pathWithQuery: "/api/gateway/git?repo=%2Ftmp%2Frepo",
        body: { action: "status" },
      },
      {
        capabilities: { commandSigning: true },
        serverCapabilities: { computeTargetSigning: true },
      }
    );

    expect(keyStoreMocks.getStoredBrowserSigningKey).toHaveBeenCalledOnce();
    expect(keyStoreMocks.getOrCreateBrowserSigningKey).not.toHaveBeenCalled();
    expect(signed.publicKeyFingerprint).toBe("cl:registeredBrowserKey");
    expect(signed.path).toBe("/api/gateway/git");
    expect(signed.query).toEqual({ repo: "/tmp/repo" });
    expect(JSON.parse(signed.signaturePayload)).toMatchObject({
      method: "POST",
      path: "/api/gateway/git",
      query: [["repo", "/tmp/repo"]],
    });
    expect(signed.signature).toEqual(expect.any(String));
  });

  it("rejects without creating a browser key when no stored key exists", async () => {
    keyStoreMocks.getStoredBrowserSigningKey.mockResolvedValue({
      ok: false,
      reason: "not_found",
    });

    await expect(
      signDesktopCommand(
        {
          method: "post",
          pathWithQuery: "/api/gateway/git",
          body: { action: "status" },
        },
        {
          capabilities: { commandSigning: true },
          serverCapabilities: { computeTargetSigning: true },
        }
      )
    ).rejects.toThrow(
      "Browser command signing is not registered for this browser."
    );
    expect(keyStoreMocks.getStoredBrowserSigningKey).toHaveBeenCalledOnce();
    expect(keyStoreMocks.getOrCreateBrowserSigningKey).not.toHaveBeenCalled();
  });
});
