import fs from "node:fs";
import path from "node:path";
import type { DesktopSessionRecord } from "../../../src/main/session/desktop-session-store.js";

/** Prepare an opt-in, MAIN-only seed; the signing private key never leaves Electron memory. */
export function prepareSameProcessAuthSeed(
  directory: string,
  userDataDir: string,
  record: DesktopSessionRecord
): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const preloadPath = path.join(directory, "same-process-auth-seed.cjs");
  fs.writeFileSync(
    preloadPath,
    renderSameProcessAuthSeed(userDataDir, record),
    {
      encoding: "utf8",
      mode: 0o600,
    }
  );
  return preloadPath;
}

/** Render fixture claims only; real availability, encryption and restore remain in Electron. */
export function renderSameProcessAuthSeed(
  userDataDir: string,
  record: DesktopSessionRecord
): string {
  return `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { generateKeyPairSync } = require("node:crypto");
const { app, safeStorage } = require("electron");
const userDataDir = ${JSON.stringify(userDataDir)};
const record = ${JSON.stringify(record)};
const receipt = { profileRawMatches: false, profileCanonicalMatches: false, registeredBeforeReady: !app.isReady(), encryptionAvailable: false, encryptions: 0, sessionWritten: false, signingKeyWritten: false, readySeedComplete: false };
globalThis.__sameProcessAuthSeedReceipt = receipt;
if (app.isReady()) throw new Error("Same-process auth seed registered after ready");
app.once("ready", () => {
  const actualProfile = app.getPath("userData");
  receipt.profileRawMatches = actualProfile === userDataDir;
  let actualCanonicalProfile;
  let requestedCanonicalProfile;
  try {
    actualCanonicalProfile = fs.realpathSync.native(actualProfile);
    requestedCanonicalProfile = fs.realpathSync.native(userDataDir);
  } catch {
    throw new Error("Same-process auth profile identity unavailable");
  }
  receipt.profileCanonicalMatches = actualCanonicalProfile === requestedCanonicalProfile;
  if (!receipt.profileCanonicalMatches) {
    throw new Error("Same-process auth profile mismatch");
  }
  receipt.encryptionAvailable = safeStorage.isEncryptionAvailable();
  if (!receipt.encryptionAvailable) throw new Error("Electron safeStorage is unavailable for auth E2E.");
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPkcs8Pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const encryptedSession = safeStorage.encryptString(JSON.stringify(record)).toString("base64");
  receipt.encryptions += 1;
  const encryptedSigningKey = safeStorage.encryptString(privateKeyPkcs8Pem).toString("base64");
  receipt.encryptions += 1;
  fs.writeFileSync(path.join(userDataDir, "desktop-session.json"), JSON.stringify({ encryptedSession }), "utf8");
  receipt.sessionWritten = true;
  fs.writeFileSync(path.join(userDataDir, "desktop-gateway-signing-keys.json"), JSON.stringify({ encryptedPrivateKeysByGatewayId: { [record.gatewayId]: encryptedSigningKey } }), "utf8");
  receipt.signingKeyWritten = true;
  receipt.readySeedComplete = true;
});
`;
}
