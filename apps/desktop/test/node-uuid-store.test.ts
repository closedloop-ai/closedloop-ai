import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import Store from "electron-store";
import {
  DESKTOP_NODE_IDENTITY_STORE_NAME,
  NODE_UUID_STORE_KEY,
  NodeUuidStore,
  UUID_V4_PATTERN,
} from "../src/main/node-uuid-store.js";

const APP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const STORE_FILE_NAME = `${DESKTOP_NODE_IDENTITY_STORE_NAME}.json`;
const TEST_STORE_NAME = DESKTOP_NODE_IDENTITY_STORE_NAME;
const VALID_UUID = "123e4567-e89b-42d3-a456-426614174000";
const NON_V4_UUID = "123e4567-e89b-12d3-a456-426614174000";
const APP_SOURCE_PATH = path.join(APP_DIR, "src/main/app.ts");
const DESKTOP_APPLICATION_NODE_UUID_FIELD_PATTERN =
  /private readonly nodeUuidStore:\s*NodeUuidStore;/;
const DESKTOP_APPLICATION_NODE_UUID_PROVISIONING_PATTERN =
  /this\.nodeUuidStore\s*=\s*new NodeUuidStore\(\);\s*this\.nodeUuidStore\.getOrCreateNodeUuid\(\);/;
const DESKTOP_APPLICATION_NODE_UUID_GETTER_PATTERN =
  /getNodeUuidForTelemetry\(\): string\s*{\s*return this\.nodeUuidStore\.getOrCreateNodeUuid\(\);\s*}/;
const DESKTOP_APPLICATION_NODE_UUID_GETTER_COMMENT_PATTERN =
  /Reserved for FEA-1983 telemetry bootstrap to read app\.installation\.id/;
const THROWAWAY_NODE_UUID_STORE_PATTERN =
  /const\s+nodeUuidStore\s*=\s*new NodeUuidStore\(\);/;

let tempRoot = "";

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "node-uuid-store-test-"));
});

afterEach(() => {
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe("NodeUuidStore", () => {
  test("generates and persists a UUIDv4 in the desktop node identity store", () => {
    const store = new NodeUuidStore({ cwd: tempRoot });

    const nodeUuid = store.getOrCreateNodeUuid();

    assert.match(nodeUuid, UUID_V4_PATTERN);
    const persisted = readPersistedStore();
    assert.equal(persisted[NODE_UUID_STORE_KEY], nodeUuid);
    assert.equal(fs.existsSync(path.join(tempRoot, STORE_FILE_NAME)), true);
  });

  test("returns the same UUID across store re-instantiation", () => {
    const first = new NodeUuidStore({
      cwd: tempRoot,
      name: TEST_STORE_NAME,
    }).getOrCreateNodeUuid();

    const second = new NodeUuidStore({
      cwd: tempRoot,
      name: TEST_STORE_NAME,
    }).getOrCreateNodeUuid();

    assert.equal(second, first);
  });

  test("preserves a seeded valid UUIDv4", () => {
    seedStore({ [NODE_UUID_STORE_KEY]: VALID_UUID });

    const nodeUuid = new NodeUuidStore({
      cwd: tempRoot,
      name: TEST_STORE_NAME,
    }).getOrCreateNodeUuid();

    assert.equal(nodeUuid, VALID_UUID);
    assert.equal(readPersistedStore()[NODE_UUID_STORE_KEY], VALID_UUID);
  });

  test("replaces malformed and non-v4 persisted values", () => {
    const invalidValues: unknown[] = ["not-a-uuid", NON_V4_UUID, 42];

    for (const [index, invalidValue] of invalidValues.entries()) {
      const storeName = `${TEST_STORE_NAME}-${index}`;
      seedStore({ [NODE_UUID_STORE_KEY]: invalidValue }, storeName);

      const nodeUuid = new NodeUuidStore({
        cwd: tempRoot,
        name: storeName,
      }).getOrCreateNodeUuid();

      assert.match(nodeUuid, UUID_V4_PATTERN);
      assert.notEqual(nodeUuid, invalidValue);
      assert.equal(
        readPersistedStore(storeName)[NODE_UUID_STORE_KEY],
        nodeUuid
      );
    }
  });

  test("preserves unrelated keys when replacing an invalid node UUID", () => {
    seedStore({
      [NODE_UUID_STORE_KEY]: "invalid",
      unrelated: "kept",
    });

    const nodeUuid = new NodeUuidStore({
      cwd: tempRoot,
      name: TEST_STORE_NAME,
    }).getOrCreateNodeUuid();

    const persisted = readPersistedStore();
    assert.match(nodeUuid, UUID_V4_PATTERN);
    assert.equal(persisted[NODE_UUID_STORE_KEY], nodeUuid);
    assert.equal(persisted.unrelated, "kept");
  });
});

describe("DesktopApplication node UUID ownership", () => {
  test("retains the node UUID store and exposes a main-process telemetry getter", () => {
    const source = fs.readFileSync(APP_SOURCE_PATH, "utf-8");

    assert.match(source, DESKTOP_APPLICATION_NODE_UUID_FIELD_PATTERN);
    assert.match(source, DESKTOP_APPLICATION_NODE_UUID_PROVISIONING_PATTERN);
    assert.match(source, DESKTOP_APPLICATION_NODE_UUID_GETTER_COMMENT_PATTERN);
    assert.match(source, DESKTOP_APPLICATION_NODE_UUID_GETTER_PATTERN);
    assert.doesNotMatch(source, THROWAWAY_NODE_UUID_STORE_PATTERN);
  });
});

function seedStore(
  value: Record<string, unknown>,
  name = TEST_STORE_NAME
): void {
  const store = new Store<Record<string, unknown>>({
    cwd: tempRoot,
    name,
  });
  store.store = value;
}

function readPersistedStore(name = TEST_STORE_NAME): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(tempRoot, `${name}.json`), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}
