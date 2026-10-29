/**
 * ISS-11213: the realtime handshake's `clientVersion` is the resolved desktop
 * build version (ISS-9743), not a raw `app.getVersion()`, which reports the
 * Electron version on an unpackaged launch. `createDesktopApplicationServices`
 * cannot run under test (it builds the whole Electron composition root), so
 * this reads its AST, as `db-host-close-wiring.test.ts` does for the worker.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Node } from "typescript6";
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isVariableDeclaration,
  ScriptKind,
  ScriptTarget,
} from "typescript6";
import { test } from "vitest";

const SERVICES_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/main/composition/desktop-services.ts"
);
const HOST_CLASS = "DesktopRealtimeHost";
const VERSION_RESOLVER = "resolveDesktopServiceVersion";

test("the realtime host is given the resolved build version", () => {
  const source = createSourceFile(
    SERVICES_PATH,
    readFileSync(SERVICES_PATH, "utf8"),
    ScriptTarget.Latest,
    true,
    ScriptKind.TS
  );
  const resolvedVersionNames: string[] = [];
  const hostClientVersions: string[] = [];
  const visit = (node: Node): void => {
    if (
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isCallExpression(node.initializer) &&
      node.initializer.expression.getText(source) === VERSION_RESOLVER
    ) {
      resolvedVersionNames.push(node.name.text);
    }
    if (
      isNewExpression(node) &&
      node.expression.getText(source) === HOST_CLASS
    ) {
      const [options] = node.arguments ?? [];
      if (options !== undefined && isObjectLiteralExpression(options)) {
        for (const property of options.properties) {
          if (
            isPropertyAssignment(property) &&
            property.name.getText(source) === "clientVersion"
          ) {
            hostClientVersions.push(property.initializer.getText(source));
          }
        }
      }
    }
    forEachChild(node, visit);
  };
  forEachChild(source, visit);

  assert.equal(resolvedVersionNames.length, 1, VERSION_RESOLVER);
  assert.deepEqual(hostClientVersions, resolvedVersionNames);
});
