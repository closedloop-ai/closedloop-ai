import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { GatewayIdentityStore } from "../src/main/gateway-identity.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-identity-test-"));
  tempDirs.push(dir);
  return dir;
}

function readFile(dir: string): string {
  return fs.readFileSync(path.join(dir, "gateway-identity.json"), "utf-8");
}

describe("GatewayIdentityStore.load", () => {
  test("first boot generates and persists a new UUID", async () => {
    const dir = makeTempDir();
    const store = new GatewayIdentityStore(dir);

    const id = await store.load();

    assert.match(id, UUID_PATTERN);
    const persisted = JSON.parse(readFile(dir)) as { gatewayId: string };
    assert.equal(persisted.gatewayId, id);
  });

  test("re-boot returns the same UUID without rewriting", async () => {
    const dir = makeTempDir();
    const first = await new GatewayIdentityStore(dir).load();
    const persistedBefore = readFile(dir);

    const second = await new GatewayIdentityStore(dir).load();
    const persistedAfter = readFile(dir);

    assert.equal(second, first);
    assert.equal(persistedAfter, persistedBefore);
  });

  test("corrupted JSON file falls back to regeneration", async () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "gateway-identity.json"),
      "{ not valid json",
      "utf-8"
    );

    const id = await new GatewayIdentityStore(dir).load();

    assert.match(id, UUID_PATTERN);
    const persisted = JSON.parse(readFile(dir)) as { gatewayId: string };
    assert.equal(persisted.gatewayId, id);
  });

  test("missing gatewayId field falls back to regeneration", async () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "gateway-identity.json"),
      JSON.stringify({}),
      "utf-8"
    );

    const id = await new GatewayIdentityStore(dir).load();

    assert.match(id, UUID_PATTERN);
    const persisted = JSON.parse(readFile(dir)) as { gatewayId: string };
    assert.equal(persisted.gatewayId, id);
  });

  test("auto-creates missing parent directory", async () => {
    const parent = makeTempDir();
    const nested = path.join(parent, "nested", "config");
    const store = new GatewayIdentityStore(nested);

    const id = await store.load();

    assert.match(id, UUID_PATTERN);
    assert.equal(
      fs.existsSync(path.join(nested, "gateway-identity.json")),
      true
    );
  });
});

describe("GatewayIdentityStore.loadSync", () => {
  test("first boot generates and persists a new UUID", () => {
    const dir = makeTempDir();
    const store = new GatewayIdentityStore(dir);

    const id = store.loadSync();

    assert.match(id, UUID_PATTERN);
    const persisted = JSON.parse(readFile(dir)) as { gatewayId: string };
    assert.equal(persisted.gatewayId, id);
  });

  test("re-boot returns the same UUID", () => {
    const dir = makeTempDir();
    const first = new GatewayIdentityStore(dir).loadSync();
    const second = new GatewayIdentityStore(dir).loadSync();
    assert.equal(second, first);
  });

  test("corrupted JSON file falls back to regeneration", () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "gateway-identity.json"),
      "not json at all",
      "utf-8"
    );

    const id = new GatewayIdentityStore(dir).loadSync();

    assert.match(id, UUID_PATTERN);
  });
});
