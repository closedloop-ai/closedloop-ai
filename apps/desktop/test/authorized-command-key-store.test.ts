import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  AuthorizedCommandKeyStore,
  fingerprintCommandPublicKey,
} from "../src/main/authorized-command-key-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AuthorizedCommandKeyStore writes ~/.closedloop authorized_keys.json schema", () => {
  const cwd = makeTempDir();
  const publicKeyBase64 = createRawPublicKeyBase64();
  const fingerprint = fingerprintCommandPublicKey(
    Buffer.from(publicKeyBase64, "base64")
  );
  const store = new AuthorizedCommandKeyStore({ cwd });

  const authorized = store.authorize({
    publicKeyBase64,
    fingerprint,
    ownerName: "Ada Lovelace",
  });

  assert.equal(authorized.fingerprint, fingerprint);
  assert.equal(authorized.source, "manual");
  assert.deepEqual(
    store.list().map((key) => key.fingerprint),
    [fingerprint]
  );
  const persisted = JSON.parse(
    readFileSync(path.join(cwd, "authorized_keys.json"), "utf8")
  ) as Record<string, unknown>;
  assert.equal(persisted.version, 1);
  assert.equal(Array.isArray(persisted.keys), true);
  assert.equal(
    (persisted.keys as Record<string, unknown>[])[0].source,
    "manual"
  );
});

test("AuthorizedCommandKeyStore persists org source metadata", () => {
  const cwd = makeTempDir();
  const publicKeyBase64 = createRawPublicKeyBase64();
  const fingerprint = fingerprintCommandPublicKey(
    Buffer.from(publicKeyBase64, "base64")
  );
  const store = new AuthorizedCommandKeyStore({ cwd });

  const authorized = store.authorize({
    publicKeyBase64,
    fingerprint,
    ownerName: "Grace Hopper",
    source: "org",
    sourceUserPublicKeyId: "user-public-key-1",
  });

  assert.equal(authorized.source, "org");
  assert.equal(authorized.sourceUserPublicKeyId, "user-public-key-1");
  const persisted = JSON.parse(
    readFileSync(path.join(cwd, "authorized_keys.json"), "utf8")
  ) as Record<string, unknown>;
  const key = (persisted.keys as Record<string, unknown>[])[0];
  assert.equal(key.source, "org");
  assert.equal(key.sourceUserPublicKeyId, "user-public-key-1");
});

test("AuthorizedCommandKeyStore loads legacy keys without provenance as unknown", () => {
  const cwd = makeTempDir();
  const publicKeyBase64 = createRawPublicKeyBase64();
  const fingerprint = fingerprintCommandPublicKey(
    Buffer.from(publicKeyBase64, "base64")
  );
  writeFileSync(
    path.join(cwd, "authorized_keys.json"),
    JSON.stringify({
      version: 1,
      keys: [
        {
          fingerprint,
          publicKeyBase64,
          ownerName: "Legacy User",
          authorizedAt: "2026-05-09T00:00:00.000Z",
        },
      ],
      rejectedFingerprints: [],
    })
  );

  const store = new AuthorizedCommandKeyStore({ cwd });

  assert.equal(store.list()[0].source, "unknown");
});

test("AuthorizedCommandKeyStore rejects malformed, duplicate, and mismatched keys", () => {
  const store = new AuthorizedCommandKeyStore({ cwd: makeTempDir() });
  const publicKeyBase64 = createRawPublicKeyBase64();

  assert.throws(
    () => store.authorize({ publicKeyBase64: "not base64", ownerName: "Bad" }),
    /invalid base64 public key/
  );
  assert.throws(
    () =>
      store.authorize({
        publicKeyBase64,
        fingerprint: "cl:wrongfingerprint",
      }),
    /fingerprint mismatch/
  );

  store.authorize({ publicKeyBase64, ownerName: "Ada" });
  assert.throws(
    () => store.authorize({ publicKeyBase64, ownerName: "Ada" }),
    /duplicate key/
  );
});

test("AuthorizedCommandKeyStore tolerates missing malformed and future files", () => {
  const cwd = makeTempDir();
  const store = new AuthorizedCommandKeyStore({ cwd });
  assert.deepEqual(store.list(), []);

  writeFileSync(path.join(cwd, "authorized_keys.json"), "{not-json");
  assert.deepEqual(store.list(), []);

  writeFileSync(
    path.join(cwd, "authorized_keys.json"),
    JSON.stringify({ version: 999, keys: [] })
  );
  assert.deepEqual(store.list(), []);
});

test("AuthorizedCommandKeyStore removes authorized keys and records rejected org keys", () => {
  const store = new AuthorizedCommandKeyStore({ cwd: makeTempDir() });
  const publicKeyBase64 = createRawPublicKeyBase64();
  const fingerprint = store.authorize({ publicKeyBase64 }).fingerprint;

  store.reject("cl:abcdefghijklmnopqrstuv");
  assert.deepEqual(store.listRejectedFingerprints(), [
    "cl:abcdefghijklmnopqrstuv",
  ]);

  store.remove(fingerprint);
  assert.deepEqual(store.list(), []);
});

test("AuthorizedCommandKeyStore reconciles stale org keys only", () => {
  const cwd = makeTempDir();
  const rejectedFingerprint = "cl:abcdefghijklmnopqrstuv";
  const keys = {
    orgKeep: makeStoredKey({ ownerName: "Org Keep", source: "org" }),
    orgRemove: makeStoredKey({ ownerName: "Org Remove", source: "org" }),
    manual: makeStoredKey({ ownerName: "Manual", source: "manual" }),
    legacyUnknown: makeStoredKey({ ownerName: "Legacy Unknown" }),
  };
  writeFileSync(
    path.join(cwd, "authorized_keys.json"),
    JSON.stringify({
      version: 1,
      keys: [
        {
          ...keys.orgKeep,
          sourceUserPublicKeyId: "server-key-keep",
        },
        {
          ...keys.orgRemove,
          sourceUserPublicKeyId: "server-key-remove",
        },
        keys.manual,
        keys.legacyUnknown,
      ],
      rejectedFingerprints: [rejectedFingerprint],
    })
  );
  const store = new AuthorizedCommandKeyStore({ cwd });

  const removed = store.reconcileOrganizationKeys([
    keys.orgKeep.fingerprint,
  ]).removed;

  assert.deepEqual(
    removed.map((key) => key.fingerprint),
    [keys.orgRemove.fingerprint]
  );
  assert.deepEqual(
    store.list().map((key) => [key.fingerprint, key.source]),
    [
      [keys.legacyUnknown.fingerprint, "unknown"],
      [keys.manual.fingerprint, "manual"],
      [keys.orgKeep.fingerprint, "org"],
    ].sort(([a], [b]) => a.localeCompare(b))
  );
  assert.deepEqual(store.listRejectedFingerprints(), [rejectedFingerprint]);
});

test("AuthorizedCommandKeyStore promotes legacy unknown org keys during reconciliation", () => {
  const cwd = makeTempDir();
  const keys = {
    legacyUnknown: makeStoredKey({ ownerName: "Legacy Unknown" }),
    manual: makeStoredKey({ ownerName: "Manual", source: "manual" }),
    staleOrg: makeStoredKey({ ownerName: "Stale Org", source: "org" }),
  };
  writeFileSync(
    path.join(cwd, "authorized_keys.json"),
    JSON.stringify({
      version: 1,
      keys: [keys.legacyUnknown, keys.manual, keys.staleOrg],
      rejectedFingerprints: ["cl:abcdefghijklmnopqrstuv"],
    })
  );
  const store = new AuthorizedCommandKeyStore({ cwd });

  const result = store.reconcileOrganizationKeys([
    {
      fingerprint: keys.legacyUnknown.fingerprint,
      sourceUserPublicKeyId: "api-public-key-1",
    },
    {
      fingerprint: keys.manual.fingerprint,
      sourceUserPublicKeyId: "api-public-key-manual",
    },
  ]);

  assert.deepEqual(
    result.removed.map((key) => key.fingerprint),
    [keys.staleOrg.fingerprint]
  );
  assert.deepEqual(
    result.promoted.map((key) => [
      key.fingerprint,
      key.source,
      key.sourceUserPublicKeyId,
    ]),
    [[keys.legacyUnknown.fingerprint, "org", "api-public-key-1"]]
  );
  const byFingerprint = new Map(
    store.list().map((key) => [key.fingerprint, key])
  );
  assert.equal(
    byFingerprint.get(keys.legacyUnknown.fingerprint)?.source,
    "org"
  );
  assert.equal(
    byFingerprint.get(keys.legacyUnknown.fingerprint)?.sourceUserPublicKeyId,
    "api-public-key-1"
  );
  assert.equal(byFingerprint.get(keys.manual.fingerprint)?.source, "manual");
  assert.equal(
    byFingerprint.get(keys.manual.fingerprint)?.sourceUserPublicKeyId,
    undefined
  );
  assert.equal(byFingerprint.has(keys.staleOrg.fingerprint), false);
  assert.deepEqual(store.listRejectedFingerprints(), [
    "cl:abcdefghijklmnopqrstuv",
  ]);
});

test("AuthorizedCommandKeyStore can promote without removing stale org keys", () => {
  const cwd = makeTempDir();
  const keys = {
    legacyUnknown: makeStoredKey({ ownerName: "Legacy Unknown" }),
    staleOrg: makeStoredKey({ ownerName: "Stale Org", source: "org" }),
  };
  writeFileSync(
    path.join(cwd, "authorized_keys.json"),
    JSON.stringify({
      version: 1,
      keys: [keys.legacyUnknown, keys.staleOrg],
      rejectedFingerprints: [],
    })
  );
  const store = new AuthorizedCommandKeyStore({ cwd });

  const result = store.reconcileOrganizationKeys(
    [
      {
        fingerprint: keys.legacyUnknown.fingerprint,
        sourceUserPublicKeyId: "api-public-key-1",
      },
    ],
    { removeStale: false }
  );

  assert.deepEqual(result.removed, []);
  assert.deepEqual(
    result.promoted.map((key) => [key.fingerprint, key.source]),
    [[keys.legacyUnknown.fingerprint, "org"]]
  );
  const byFingerprint = new Map(
    store.list().map((key) => [key.fingerprint, key])
  );
  assert.equal(
    byFingerprint.get(keys.legacyUnknown.fingerprint)?.source,
    "org"
  );
  assert.equal(byFingerprint.get(keys.staleOrg.fingerprint)?.source, "org");
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "authorized-keys-"));
  tempDirs.push(dir);
  return dir;
}

function createRawPublicKeyBase64(): string {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return spki.subarray(spki.length - 32).toString("base64");
}

function makeStoredKey(options: {
  ownerName: string;
  source?: "org" | "manual";
}): Record<string, unknown> {
  const publicKeyBase64 = createRawPublicKeyBase64();
  return {
    fingerprint: fingerprintCommandPublicKey(
      Buffer.from(publicKeyBase64, "base64")
    ),
    publicKeyBase64,
    ownerName: options.ownerName,
    authorizedAt: "2026-05-09T00:00:00.000Z",
    ...(options.source ? { source: options.source } : {}),
  };
}
