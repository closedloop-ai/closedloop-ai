/**
 * ISS-12222: the composition root must install the replay request auth on the
 * renderer's session, reading the live API origin and an access token bound to
 * the origin that minted it, and it
 * must stay the session's only `onBeforeSendHeaders` listener: Electron keeps
 * one per session, so a second registration anywhere in main silently replaces
 * it and every signed-in replay falls back to the install's `node_uuid`.
 * It must also wait for `ready`, before which `session.defaultSession` throws.
 * `desktop-services.ts` statically imports `electron`, so this reads the AST.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Node } from "typescript6";
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isVariableDeclaration,
  ScriptTarget,
} from "typescript6";
import { test } from "vitest";
import {
  calleeArgument,
  calleeCall,
  initializerCall,
  propertyInitializer,
  propertyInitializerText,
} from "./desktop-services-ast-helpers.js";

const INSTALLER = "installDesktopReplayRequestAuth";
const LISTENER_REGISTRATION = "onBeforeSendHeaders";
const SOURCE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src"
);
const INSTALLER_MODULE = path.join(
  "main",
  "auth",
  "desktop-replay-request-auth.ts"
);
const TYPESCRIPT_SOURCE = /\.tsx?$/;

test("the composition root installs the replay request auth on the default session", () => {
  const options = calleeArgument(INSTALLER);
  assert.ok(options, `${INSTALLER} is never called`);

  assert.equal(
    propertyInitializerText(options, "session"),
    "session.defaultSession"
  );
  const accessToken = propertyInitializer(options, "getAccessToken");
  assert.ok(accessToken, "the installer is given no access-token reader");
  assert.deepEqual(initializerCall(accessToken), {
    deferred: true,
    callee: "getAccessTokenIssuedBy",
    argumentNames: ["origin"],
  });
  const apiOrigin = propertyInitializer(options, "resolveApiOrigin");
  assert.ok(apiOrigin, "the installer is given no API-origin reader");
  assert.equal(initializerCall(apiOrigin)?.deferred, true);
  assert.equal(
    initializerCall(apiOrigin)?.callee,
    "normalizeAndValidateOrigin"
  );
});

// `session.defaultSession` throws before `ready`, and the composition root runs
// before it, so a synchronous install fails every launch.
test("the composition root installs it only once the app is ready", () => {
  const options = calleeArgument(INSTALLER);
  assert.ok(options, `${INSTALLER} is never called`);

  assert.ok(
    insideWhenReadyThen(options),
    `${INSTALLER} runs before \`app.whenReady()\` resolves`
  );
});

// ISS-12257: the installer refuses replay batches through the same fence the
// renderer's report reaches, and that fence reads main's own sign-in state and
// the auth generation main pushes to the renderer.
test("the installer and the renderer's recording report share one fence over main's sign-in state", () => {
  const fence = calleeCall("createDesktopReplayRecordingFence");
  assert.ok(fence, "the composition root creates no replay recording fence");
  assert.ok(
    isVariableDeclaration(fence.parent) && isIdentifier(fence.parent.name),
    "the fence is not kept in a variable"
  );
  const fenceName = fence.parent.name.text;
  const [isSignedIn, authGeneration] = fence.arguments;
  assert.ok(isSignedIn, "the fence is given no sign-in reader");
  assert.deepEqual(initializerCall(isSignedIn), {
    deferred: true,
    callee: "isAuthenticated",
    argumentNames: [],
  });
  assert.equal(
    authGeneration?.getText(),
    "() => desktopSessionManager.getState().authGeneration",
    "the fence does not read the auth generation main publishes"
  );

  const options = calleeArgument(INSTALLER);
  assert.ok(options, `${INSTALLER} is never called`);
  assert.equal(
    propertyInitializerText(options, "isRecordingSignInCurrent"),
    `${fenceName}.isCurrent`
  );

  const registration = calleeCall("registerDesktopReplayRecordingIpcHandler");
  assert.ok(registration, "the renderer's recording report is never handled");
  const [ipc, handlerDeps] = registration.arguments;
  assert.equal(ipc?.getText(), "ipcMain");
  assert.ok(handlerDeps && isObjectLiteralExpression(handlerDeps));
  assert.equal(
    propertyInitializerText(handlerDeps, "report"),
    `${fenceName}.report`
  );
  const trustedSender = propertyInitializer(handlerDeps, "isTrustedSender");
  assert.ok(trustedSender, "the report handler checks no sender");
  assert.equal(initializerCall(trustedSender)?.callee, "isTrustedSender");
});

test("nothing else in the main process registers an onBeforeSendHeaders listener", () => {
  const registrations = mainProcessSourceFiles().filter((file) =>
    registersBeforeSendHeaders(file)
  );

  assert.deepEqual(registrations, [INSTALLER_MODULE]);
});

/** Whether `node` sits in a callback passed to `<x>.whenReady().then(...)`. */
function insideWhenReadyThen(node: Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (
      isCallExpression(current) &&
      isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === "then" &&
      isCallExpression(current.expression.expression) &&
      isPropertyAccessExpression(current.expression.expression.expression) &&
      current.expression.expression.expression.name.text === "whenReady"
    ) {
      return true;
    }
  }
  return false;
}

/** Every TypeScript file under `src` except the renderer, which has no session. */
function mainProcessSourceFiles(): string[] {
  return readdirSync(SOURCE_ROOT, { recursive: true, encoding: "utf8" })
    .filter((file) => TYPESCRIPT_SOURCE.test(file))
    .filter((file) => !file.startsWith(`renderer${path.sep}`))
    .sort();
}

function registersBeforeSendHeaders(file: string): boolean {
  const source = createSourceFile(
    file,
    readFileSync(path.join(SOURCE_ROOT, file), "utf8"),
    ScriptTarget.Latest
  );
  let found = false;
  const visit = (node: Node): void => {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === LISTENER_REGISTRATION
    ) {
      found = true;
    }
    if (!found) {
      forEachChild(node, visit);
    }
  };
  forEachChild(source, visit);
  return found;
}
