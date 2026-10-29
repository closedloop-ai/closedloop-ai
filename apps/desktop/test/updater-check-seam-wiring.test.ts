/**
 * ISS-9164 — every `autoUpdater.checkForUpdates()` in this app goes through the
 * stamping seam, so no check can be issued carrying another check's headers.
 *
 * WHY A GUARD AND NOT A RUNTIME TEST. `requestHeaders` is a sticky property on
 * the `electron-updater` singleton, so the MANUAL check site — the renderer's
 * update IPC — was not issuing unstamped requests before #6867; it was issuing
 * whatever the last SCHEDULED check left behind. At boot that is version-only,
 * because the compute target is hello-derived and null for the first seconds
 * of a launch, so a user who launched and hit "Check for updates" straight away
 * landed on the general ring — precisely what someone in the internal ring does
 * when they hear there is a new build (marisolashgrove, #6867). That defect is
 * invisible to its consumer's suite: `update-ipc.test.ts` injects
 * `checkForUpdates` as a dep, so the arrow that supplies it is the one thing it
 * cannot see, and the owning module statically imports `electron` and cannot
 * be constructed in a node test. This is the sanctioned
 * `ts.createSourceFile` alternative to a raw text scan
 * (`scripts/lint/rules/no-raw-text-source-scan.ts`), read off the AST rather
 * than the text so a comment naming the seam cannot satisfy it.
 *
 * The seam's own behaviour — that it re-stamps before every check, and drops an
 * id that has gone away rather than leaving the last one on the singleton — is
 * pinned at runtime in `auto-update-request-headers.test.ts`. This file pins
 * only that the manual site reaches it, and that the IPC bag is handed the
 * updater's own target accessor rather than the strict-online one its
 * neighbours in that same bag use. What that accessor then resolves to is
 * `session-sync-identity-adapter.test.ts`.
 *
 * The last case is ISS-10291's ordering: the renderer's check IPC is live from
 * the constructor, so the update state machine must be installed before it, or
 * an update that check finds is emitted to no listener.
 */
import assert from "node:assert/strict";
import type { ConstructorDeclaration, Node } from "typescript6";
import {
  forEachChild,
  isBinaryExpression,
  isClassDeclaration,
  isConstructorDeclaration,
  isExpressionStatement,
} from "typescript6";
import { test } from "vitest";
import {
  appHostAccessor,
  mainModuleAccessor,
} from "./desktop-app-host-ast-helpers.js";
import { initializerCall } from "./desktop-services-ast-helpers.js";
import { parseAppModule } from "./support/app-module-ast.js";

const IPC_REGISTRATION = "ipc/desktop-ipc-registration.ts";
const SEAM = "checkForStampedUpdates";
const CHECK_ACCESSOR = "checkForUpdates";

test("the renderer's update IPC checks through the stamping seam", () => {
  const initializer = mainModuleAccessor(IPC_REGISTRATION, CHECK_ACCESSOR);

  assert.ok(initializer, `${IPC_REGISTRATION} declares no ${CHECK_ACCESSOR}`);
  const call = initializerCall(initializer);
  assert.equal(
    call?.callee,
    SEAM,
    "the renderer's Check for updates calls the updater singleton directly, so its check carries whatever the last scheduled check stamped"
  );
  assert.equal(call?.deferred, true);
});

test("the id the IPC seam is handed is the updater's, not the transcript lane's", () => {
  // Its neighbours in the same deps bag are wired to `onlineComputeTargetId`,
  // which is exactly the id an unauthenticated feed must not be sent.
  const initializer = appHostAccessor("getUpdaterComputeTargetId");

  assert.ok(initializer, "app.ts supplies the IPC bag no updater target");
  assert.equal(
    initializerCall(initializer)?.callee,
    "updaterComputeTargetId",
    "the IPC bag's updater target is resolved from some other accessor, so the renderer's check can stamp a different ring than the poll beside it"
  );
});

test("the constructor installs the update lane before it wires the IPC that can check", () => {
  const callees = constructorStatementCallees();
  const install = callees.indexOf("installDesktopUpdateLane");
  const ipc = callees.indexOf("registerIpcHandlers");

  assert.ok(
    install >= 0,
    "the DesktopApplication constructor installs no update lane"
  );
  assert.ok(
    ipc >= 0,
    "the DesktopApplication constructor registers no IPC handlers"
  );
  assert.ok(
    install < ipc,
    "the renderer's check IPC is wired before the update state machine, so an update it finds before boot reaches no listener"
  );
});

/** What each top-level statement of the `DesktopApplication` constructor calls, in order. */
function constructorStatementCallees(): string[] {
  const source = parseAppModule();
  let ctor: ConstructorDeclaration | undefined;
  const visit = (node: Node): void => {
    if (isClassDeclaration(node) && node.name?.text === "DesktopApplication") {
      ctor = node.members.find(isConstructorDeclaration);
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(source, visit);
  const callees: string[] = [];
  for (const statement of ctor?.body?.statements ?? []) {
    if (!isExpressionStatement(statement)) {
      continue;
    }
    const { expression } = statement;
    const call = initializerCall(
      isBinaryExpression(expression) ? expression.right : expression
    );
    if (call) {
      callees.push(call.callee);
    }
  }
  return callees;
}
