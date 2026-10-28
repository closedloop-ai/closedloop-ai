import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { renderSameProcessAuthSeed } from "./e2e/helpers/same-process-auth-seed";

const profilePath = "/synthetic/desktop-profile";
const record = {
  refreshToken: "synthetic-refresh",
  refreshTokenExpiresAt: "2027-01-01T00:00:00.000Z",
  userId: "synthetic-user",
  organizationId: "synthetic-organization",
  gatewayId: "synthetic-gateway",
};
const receiptSchema = z
  .object({
    profileRawMatches: z.boolean(),
    profileCanonicalMatches: z.boolean(),
    registeredBeforeReady: z.boolean(),
    encryptionAvailable: z.boolean(),
    encryptions: z.number(),
    sessionWritten: z.boolean(),
    signingKeyWritten: z.boolean(),
    readySeedComplete: z.boolean(),
  })
  .strict();

describe("same-process authenticated seed", () => {
  it("encrypts both records before writing and before later ready listeners", () => {
    const fixture = createFixture();
    fixture.install();
    const productionReady = vi.fn(() => {
      expect(fixture.receipt().readySeedComplete).toBe(true);
      expect(fixture.writes.size).toBe(2);
    });
    fixture.app.on("ready", productionReady);
    fixture.app.emit("ready");
    expect(productionReady).toHaveBeenCalledOnce();
    expect(fixture.getPath).toHaveBeenCalledExactlyOnceWith("userData");
    expect(fixture.realpath).toHaveBeenCalledTimes(2);
    expect(fixture.generateKey).toHaveBeenCalledWith("ed25519");
    expect(fixture.encrypt).toHaveBeenCalledTimes(2);
    expect(fixture.encrypt.mock.calls[0]?.[0]).toBe(JSON.stringify(record));
    expect(fixture.encrypt.mock.calls[1]?.[0]).toContain("BEGIN PRIVATE KEY");
    expect(fixture.events).toEqual(["encrypt", "encrypt", "write", "write"]);
    expect(fixture.receipt()).toEqual({
      profileRawMatches: true,
      profileCanonicalMatches: true,
      registeredBeforeReady: true,
      encryptionAvailable: true,
      encryptions: 2,
      sessionWritten: true,
      signingKeyWritten: true,
      readySeedComplete: true,
    });
  });

  it("never persists plaintext session claims or private PEM", () => {
    const fixture = createFixture();
    fixture.install();
    fixture.app.emit("ready");
    for (const contents of fixture.writes.values()) {
      expect(contents).not.toContain(record.refreshToken);
      expect(contents).not.toContain("BEGIN PRIVATE KEY");
    }
  });

  it("refuses unavailable real encryption before any crypto or writes", () => {
    const fixture = createFixture({ available: false });
    fixture.install();
    expect(() => fixture.app.emit("ready")).toThrow(
      "safeStorage is unavailable"
    );
    expect(fixture.generateKey).not.toHaveBeenCalled();
    expect(fixture.encrypt).not.toHaveBeenCalled();
    expect(fixture.writes.size).toBe(0);
  });

  it("refuses registration after ready", () => {
    const fixture = createFixture({ alreadyReady: true });
    expect(fixture.install).toThrow("registered after ready");
    expect(fixture.app.listenerCount("ready")).toBe(0);
    expect(fixture.encrypt).not.toHaveBeenCalled();
  });

  it("refuses a different production user-data path", () => {
    const fixture = createFixture({
      actualProfile: "/synthetic/other-profile",
    });
    fixture.install();
    expect(() => fixture.app.emit("ready")).toThrow("profile mismatch");
    expect(fixture.generateKey).not.toHaveBeenCalled();
    expect(fixture.encrypt).not.toHaveBeenCalled();
    expect(fixture.writes.size).toBe(0);
    expect(fixture.receipt().profileCanonicalMatches).toBe(false);
    expect(fixture.receipt().profileRawMatches).toBe(false);
    expect(fixture.getPath).toHaveBeenCalledExactlyOnceWith("userData");
    expect(fixture.realpath.mock.calls).toEqual([
      ["/synthetic/other-profile"],
      [profilePath],
    ]);
  });

  it("accepts two spellings of the same existing canonical directory without changing ready order", () => {
    const fixture = createFixture({
      actualProfile: "/synthetic/profile-alias",
      actualCanonical: profilePath,
    });
    fixture.install();
    const productionReady = vi.fn();
    fixture.app.on("ready", productionReady);
    fixture.app.emit("ready");
    expect(fixture.receipt().profileRawMatches).toBe(false);
    expect(fixture.receipt().profileCanonicalMatches).toBe(true);
    expect(fixture.receipt().readySeedComplete).toBe(true);
    expect(fixture.generateKey).toHaveBeenCalledExactlyOnceWith("ed25519");
    expect(fixture.encrypt).toHaveBeenCalledTimes(2);
    expect(fixture.events).toEqual(["encrypt", "encrypt", "write", "write"]);
    expect(productionReady).toHaveBeenCalledOnce();
  });

  it("rejects the default profile when the requested fixture directory is different", () => {
    const fixture = createFixture({
      actualProfile: "/synthetic/default-profile",
    });
    fixture.install();
    expect(() => fixture.app.emit("ready")).toThrow("profile mismatch");
    expect(fixture.receipt().profileRawMatches).toBe(false);
    expect(fixture.receipt().profileCanonicalMatches).toBe(false);
    expect(fixture.generateKey).not.toHaveBeenCalled();
    expect(fixture.encrypt).not.toHaveBeenCalled();
    expect(fixture.writes.size).toBe(0);
  });

  it.each(["actual", "requested"] as const)(
    "fails closed if the %s existing-directory identity cannot be resolved",
    (unresolvedProfile) => {
      const fixture = createFixture({
        actualProfile: "/synthetic/profile-alias",
        unresolvedProfile,
      });
      fixture.install();
      expect(() => fixture.app.emit("ready")).toThrow(
        "profile identity unavailable"
      );
      expect(fixture.getPath).toHaveBeenCalledExactlyOnceWith("userData");
      const attemptedPaths = [["/synthetic/profile-alias"]];
      if (unresolvedProfile === "requested") {
        attemptedPaths.push([profilePath]);
      }
      expect(fixture.realpath.mock.calls).toEqual(attemptedPaths);
      expect(fixture.receipt().profileCanonicalMatches).toBe(false);
      expect(fixture.generateKey).not.toHaveBeenCalled();
      expect(fixture.encrypt).not.toHaveBeenCalled();
      expect(fixture.writes.size).toBe(0);
    }
  );

  it("propagates getPath refusal before identity resolution or crypto", () => {
    const error = new Error("synthetic getPath refusal");
    const fixture = createFixture({ getPathError: error });
    fixture.install();
    expect(() => fixture.app.emit("ready")).toThrow(error);
    expect(fixture.getPath).toHaveBeenCalledExactlyOnceWith("userData");
    expect(fixture.realpath).not.toHaveBeenCalled();
    expect(fixture.generateKey).not.toHaveBeenCalled();
    expect(fixture.receipt().readySeedComplete).toBe(false);
    expect(fixture.encrypt).not.toHaveBeenCalled();
    expect(fixture.writes.size).toBe(0);
  });

  it("persists neither record if the second encryption fails", () => {
    const fixture = createFixture();
    fixture.encrypt.mockImplementationOnce(() => Buffer.from("encrypted"));
    fixture.encrypt.mockImplementationOnce(() => {
      throw new Error("second encryption failed");
    });
    fixture.install();
    expect(() => fixture.app.emit("ready")).toThrow("second encryption failed");
    expect(fixture.encrypt).toHaveBeenCalledTimes(2);
    expect(fixture.receipt().encryptions).toBe(1);
    expect(fixture.receipt().sessionWritten).toBe(false);
    expect(fixture.receipt().signingKeyWritten).toBe(false);
    expect(fixture.writes.size).toBe(0);
    expect(fixture.receipt().readySeedComplete).toBe(false);
  });

  it("consumes its ready listener exactly once", () => {
    const fixture = createFixture();
    fixture.install();
    fixture.app.emit("ready");
    fixture.app.emit("ready");
    expect(fixture.app.listenerCount("ready")).toBe(0);
    expect(fixture.encrypt).toHaveBeenCalledTimes(2);
  });
});

function createFixture(
  options: {
    available?: boolean;
    alreadyReady?: boolean;
    actualProfile?: string;
    getPathError?: Error;
    actualCanonical?: string;
    unresolvedProfile?: "actual" | "requested";
  } = {}
) {
  const getPath = vi.fn((_name: string) => {
    if (options.getPathError) {
      throw options.getPathError;
    }
    return options.actualProfile ?? profilePath;
  });
  const realpath = vi.fn((value: string) => {
    const requested = value === profilePath;
    if (
      (requested && options.unresolvedProfile === "requested") ||
      (!requested && options.unresolvedProfile === "actual")
    ) {
      throw new Error("synthetic unresolved identity");
    }
    return requested ? profilePath : (options.actualCanonical ?? value);
  });
  const app = Object.assign(new EventEmitter(), {
    isReady: () => options.alreadyReady ?? false,
    getPath,
  });
  const events: string[] = [];
  const writes = new Map<string, string>();
  const encrypt = vi.fn((_value: string) => {
    events.push("encrypt");
    return Buffer.from("encrypted-fixture-record");
  });
  const generateKey = vi.fn(generateKeyPairSync);
  const context: Record<string, unknown> = {
    require: (name: string) => {
      if (name === "electron") {
        return {
          app,
          safeStorage: {
            isEncryptionAvailable: () => options.available ?? true,
            encryptString: encrypt,
          },
        };
      }
      if (name === "node:crypto") {
        return { generateKeyPairSync: generateKey };
      }
      if (name === "node:path") {
        return { join: (...parts: string[]) => parts.join("/") };
      }
      if (name === "node:fs") {
        return {
          realpathSync: { native: realpath },
          writeFileSync: (filePath: string, value: string) => {
            events.push("write");
            writes.set(filePath, value);
          },
        };
      }
      throw new Error(`Unexpected generated-preload module: ${name}`);
    },
  };
  return {
    app,
    events,
    writes,
    encrypt,
    generateKey,
    getPath,
    realpath,
    install: () =>
      runInNewContext(renderSameProcessAuthSeed(profilePath, record), context),
    receipt: () => receiptSchema.parse(context.__sameProcessAuthSeedReceipt),
  };
}
