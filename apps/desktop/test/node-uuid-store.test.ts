import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import Store from "electron-store";
import ts from "typescript6";
import {
  DESKTOP_NODE_IDENTITY_STORE_NAME,
  NODE_UUID_STORE_KEY,
  NodeUuidStore,
  UUID_V4_PATTERN,
} from "../src/main/util/node-uuid-store.js";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";

const APP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const STORE_FILE_NAME = `${DESKTOP_NODE_IDENTITY_STORE_NAME}.json`;
const TEST_STORE_NAME = DESKTOP_NODE_IDENTITY_STORE_NAME;
const VALID_UUID = "123e4567-e89b-42d3-a456-426614174000";
const NON_V4_UUID = "123e4567-e89b-12d3-a456-426614174000";
const APP_SOURCE_PATH = path.join(APP_DIR, "src/main/app.ts");
const NODE_UUID_STORE_FIELD = "nodeUuidStore";
const NODE_UUID_STORE_TYPE = "NodeUuidStore";
const APPLICATION_CLASS = "DesktopApplication";
const TELEMETRY_GETTER = "getNodeUuidForTelemetry";
const STORE_ACCESSOR = "getOrCreateNodeUuid";

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
  // Structural ownership invariant, asserted on the parsed AST rather than on
  // raw source text (AGENTS.md → "Test Practices"). The text version of this
  // test also pinned an explanatory COMMENT next to the getter, which is the
  // textbook "satisfied by a comment" failure — a comment is not a contract, so
  // that assertion is gone rather than ported.
  test("retains the node UUID store and exposes a main-process telemetry getter", () => {
    // Anchored to the class: a whole-file scan would be satisfied by a matching
    // field or getter on ANY class in app.ts, which is not the invariant.
    const applicationClass = classNamed(
      parseTypeScriptFile(APP_SOURCE_PATH),
      APPLICATION_CLASS
    );

    assert.ok(
      applicationClass,
      `${APP_SOURCE_PATH} must declare class ${APPLICATION_CLASS}`
    );
    assert.ok(
      applicationClass.members.some(isOwnedNodeUuidStoreField),
      `${APPLICATION_CLASS} must keep a private readonly ${NODE_UUID_STORE_FIELD}: ${NODE_UUID_STORE_TYPE} field`
    );
    assert.ok(
      applicationClass.members.some(isTelemetryGetterReturningStoreValue),
      `${APPLICATION_CLASS}.${TELEMETRY_GETTER}() must return this.${NODE_UUID_STORE_FIELD}.${STORE_ACCESSOR}()`
    );
    // The application must not build its own store — it receives the single
    // owned instance from the composition root.
    assert.ok(
      !hasAppNode(applicationClass, isThrowawayNodeUuidStoreConstruction),
      `${APPLICATION_CLASS} must not construct its own ${NODE_UUID_STORE_TYPE}; it receives the owned instance`
    );
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

/** Does any node under `root` satisfy `predicate`? */
function hasAppNode(
  root: ts.Node,
  predicate: (node: ts.Node) => boolean
): boolean {
  let found = false;
  forEachNode(root, (node) => {
    found = found || predicate(node);
  });
  return found;
}

/** The `class <name> { … }` declaration in `app`, if it has one. */
function classNamed(
  app: ts.SourceFile,
  name: string
): ts.ClassDeclaration | undefined {
  return app.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === name
  );
}

/** `private readonly nodeUuidStore: NodeUuidStore;`. */
function isOwnedNodeUuidStoreField(node: ts.Node): boolean {
  if (!(ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name))) {
    return false;
  }
  const modifiers = node.modifiers ?? [];
  const hasModifier = (kind: ts.SyntaxKind): boolean =>
    modifiers.some((modifier) => modifier.kind === kind);
  return (
    node.name.text === NODE_UUID_STORE_FIELD &&
    hasModifier(ts.SyntaxKind.PrivateKeyword) &&
    hasModifier(ts.SyntaxKind.ReadonlyKeyword) &&
    node.type !== undefined &&
    ts.isTypeReferenceNode(node.type) &&
    ts.isIdentifier(node.type.typeName) &&
    node.type.typeName.text === NODE_UUID_STORE_TYPE
  );
}

/**
 * `getNodeUuidForTelemetry() { return this.nodeUuidStore.getOrCreateNodeUuid(); }`.
 *
 * The method's OWN return statement, not any return in its subtree: a subtree
 * walk is satisfied by a nested closure that never runs — `const unused = () =>
 * this.nodeUuidStore.getOrCreateNodeUuid(); return "";` — while telemetry ships
 * an empty node UUID.
 */
function isTelemetryGetterReturningStoreValue(
  member: ts.ClassElement
): boolean {
  if (
    !(
      ts.isMethodDeclaration(member) &&
      ts.isIdentifier(member.name) &&
      member.name.text === TELEMETRY_GETTER
    )
  ) {
    return false;
  }
  return (member.body?.statements ?? []).some(
    (statement) =>
      ts.isReturnStatement(statement) &&
      statement.expression !== undefined &&
      isOwnedStoreAccessorCall(statement.expression)
  );
}

/** `this.nodeUuidStore.getOrCreateNodeUuid()`. */
function isOwnedStoreAccessorCall(node: ts.Expression): boolean {
  if (
    !(
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    )
  ) {
    return false;
  }
  const accessor = node.expression;
  return (
    accessor.name.text === STORE_ACCESSOR &&
    ts.isPropertyAccessExpression(accessor.expression) &&
    accessor.expression.name.text === NODE_UUID_STORE_FIELD &&
    accessor.expression.expression.kind === ts.SyntaxKind.ThisKeyword
  );
}

/** `new NodeUuidStore()` built locally instead of injected. */
function isThrowawayNodeUuidStoreConstruction(node: ts.Node): boolean {
  return (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === NODE_UUID_STORE_TYPE
  );
}
