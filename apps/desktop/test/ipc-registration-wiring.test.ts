import assert from "node:assert/strict";
import { join } from "node:path";
import ts from "typescript6";
import { describe, test } from "vitest";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";

// ISS-5300 (PRD-618): the seven `src/main/ipc/*-ipc.ts` registrars this PR
// covers are each exercised by their own suite against a fake registrar. Those
// suites all stay green if a call site in the composition root is deleted or
// never added — the root AGENTS.md rule "test the production wiring, not only
// the unit". This pins the wiring itself.
//
// Structural, not behavioural, because importing `desktop-ipc-registration.ts`
// evaluates Electron bootstrap. AGENTS.md forbids regexing raw source for this
// (`scripts/lint/rules/no-raw-text-source-scan.ts`); the sanctioned route is the
// TypeScript AST, via the shared `test/helpers/ts-ast.ts` plumbing.
//
// It COUNTS rather than merely finds. A presence check ("is this registrar
// called?") cannot catch the double-registration bug, and Electron's real
// `ipcMain.handle` throws on a second handler for a channel — so a registrar
// wired twice crashes the app at boot while a presence assertion stays green.
//
// Counting also has to be AST-based rather than textual for a reason visible in
// this very file: `registerLogsActivityIpcHandlers` and
// `registerManagedKeyHintIpcHandlers` each appear a THIRD time in the source, in
// the JSDoc at :232-234 that documents them as deliberately ungated. `ts.forEachChild`
// does not descend into JSDoc, so the AST sees the import and the call and not
// the prose — a `grep -c` would read 3 and be wrong.

const REGISTRATION_MODULE = join(
  import.meta.dirname,
  "../src/main/ipc/desktop-ipc-registration.ts"
);

/** The registrars ISS-5300 covers with a dedicated suite. */
const COVERED_REGISTRARS = [
  "registerApprovalsIpcHandlers",
  "registerBinaryPathsIpcHandlers",
  "registerCloudControlIpcHandlers",
  "registerCostReconciliationIpcHandlers",
  // ISS-7249: covered by `test/dead-end-telemetry.test.ts`, which drives the
  // handler against a fake registrar — so without this entry the whole dead-end
  // channel could be dropped from boot with that suite still green.
  "registerDeadEndTelemetryIpcHandlers",
  "registerLogsActivityIpcHandlers",
  "registerManagedKeyHintIpcHandlers",
  // ISS-10412: covered by `test/desktop-auth-ipc.test.ts`, which drives the
  // handlers against a fake registrar — so without this entry the whole
  // sign-in channel group could be dropped from boot with that suite still
  // green. The handback DEP inside it is pinned separately below.
  "registerDesktopAuthIpcHandlers",
  // ISS-8376: covered by `test/onboarding-local-state-ipc.test.ts`, which
  // drives the handler against a fake registrar — so without this entry the
  // onboarding local-state read could be dropped from boot with that suite
  // still green.
  "registerOnboardingLocalStateIpcHandlers",
  // ISS-8379: covered by `test/settings-local-device-ipc.test.ts`, which drives
  // the handler against a fake registrar — so without this entry the Settings
  // host read could be dropped from boot with that suite still green.
  "registerSettingsLocalDeviceIpcHandlers",
] as const;

/** The function that actually performs registration at boot. */
const REGISTRATION_FUNCTION = "registerAllDesktopIpcHandlers";

/**
 * The ISS-6206 deps builder. Its binding of each getter to a store is executed
 * by `cloud-read-readiness-projection.test.ts`; this file only pins that the
 * composition root goes through it.
 */
const PROJECTOR_DEPS_BUILDER = "buildCloudReadReadinessProjectorDeps";

/**
 * ISS-8143: the two builders for the remaining composition-root degradations.
 * Their bindings — including the per-call re-read that keeps them following a
 * runtime or lane built AFTER registration — are executed by
 * `agent-dashboard-runtime-degradations.test.ts`; this file only pins that the
 * composition root goes through them instead of re-deriving the closures where
 * no test can reach.
 */
const RUNTIME_PROGRESS_BUILDER = "buildAgentDashboardRuntimeProgressGetters";
/**
 * ISS-8346: the onboarding estimate's byte-movement producer. Its per-call
 * re-read is executed next door; only this file can see that the shipped app
 * hands it the live runtime getter rather than a thunk over the boot-time null,
 * which would leave the estimate with no producer on every machine.
 */
const PARSE_PROGRESS_BUILDER = "buildOnboardingParseProgressReader";
/** The helper the boot function delegates the transcript registrations to. */
const TRANSCRIPT_REGISTRATION_FUNCTION = "registerDesktopTranscriptIpcHandlers";
const FORCE_SYNC_BUILDER = "buildTranscriptForceSyncOversized";

/** ISS-7516: the no-lane transcript status snapshot and the identity it needs. */
const LANE_ABSENT_STATUS = "transcriptSyncLaneAbsentStatus";
const TRANSCRIPT_IDENTITY_DEP = "getTranscriptComputeTargetId";

/**
 * The body of {@link REGISTRATION_FUNCTION}. Counting over the whole SourceFile
 * would accept a registrar called from anywhere in the module — dead code, a
 * helper nothing reaches — and still report the wiring as sound. Scoping the
 * walk to the boot function is what makes the count mean "registered at boot".
 */
function registrationFunctionBody(root: ts.SourceFile): ts.Node {
  let found: ts.Node | undefined;
  forEachNode(root, (node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === REGISTRATION_FUNCTION &&
      node.body
    ) {
      found = node.body;
    }
  });
  if (!found) {
    throw new Error(
      `${REGISTRATION_FUNCTION} not found in desktop-ipc-registration.ts — the wiring guard is pointed at the wrong function`
    );
  }
  return found;
}

/**
 * ISS-8143: the body of any named function declaration in this module. Same
 * reason as {@link registrationFunctionBody} — the transcript registrations sit
 * in `registerDesktopTranscriptIpcHandlers`, a helper the boot function calls,
 * so counting them at boot scope reports zero and counting them over the whole
 * SourceFile would accept a call from dead code.
 */
function namedFunctionBody(root: ts.SourceFile, name: string): ts.Node {
  let found: ts.Node | undefined;
  forEachNode(root, (node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === name &&
      node.body
    ) {
      found = node.body;
    }
  });
  if (!found) {
    throw new Error(
      `${name} not found in desktop-ipc-registration.ts — the wiring guard is pointed at the wrong function`
    );
  }
  return found;
}

function countDirectCalls(scope: ts.Node, calleeName: string): number {
  let count = 0;
  forEachNode(scope, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    const callee = node.expression;
    if (ts.isIdentifier(callee) && callee.text === calleeName) {
      count += 1;
    }
  });
  return count;
}

function importedNames(root: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  forEachNode(root, (node) => {
    if (!ts.isImportSpecifier(node)) {
      return;
    }
    names.add(node.name.text);
  });
  return names;
}

/**
 * The name of the function called to produce `calleeName`'s only argument, or
 * `null` when that argument is anything else — an object literal, a variable, a
 * member expression. Deliberately NOT a property-name walk: a literal's keys say
 * what the deps are CALLED, never where their values come from, which is the
 * whole distinction this guard got wrong once already.
 */
/**
 * The PROPERTY name of the call producing `calleeName`'s only argument — the
 * `x` of `foo(deps.x())` — or `null` when the argument is anything else,
 * including a literal. The sibling above resolves a bare identifier callee;
 * a dep read off the injected `deps` object is a property access, and a guard
 * that could not see one would report a hardcoded `null` as "not a call" and
 * be indistinguishable from a missing wire.
 */
function soleCallArgumentPropertyCallee(
  scope: ts.Node,
  calleeName: string
): string | null {
  let found: string | null = null;
  forEachNode(scope, (node) => {
    if (
      !(ts.isCallExpression(node) && ts.isIdentifier(node.expression)) ||
      node.expression.text !== calleeName
    ) {
      return;
    }
    const [argument] = node.arguments;
    if (
      argument &&
      ts.isCallExpression(argument) &&
      ts.isPropertyAccessExpression(argument.expression)
    ) {
      found = argument.expression.name.text;
    }
  });
  return found;
}

/**
 * ISS-8143: the NAME of the bare property-access argument a call is given —
 * `f(deps.getFoo)`, where the sibling {@link soleCallArgumentPropertyCallee}
 * wants `f(deps.getFoo())`. Without this, the builder guards below could only
 * see THAT a builder was called, and `buildAgentDashboardRuntimeProgressGetters(
 * () => null)` would keep them green while every install reported no collectors.
 */
function soleCallArgumentPropertyName(
  scope: ts.Node,
  calleeName: string
): string | null {
  let found: string | null = null;
  forEachNode(scope, (node) => {
    if (
      !(ts.isCallExpression(node) && ts.isIdentifier(node.expression)) ||
      node.expression.text !== calleeName
    ) {
      return;
    }
    const [argument] = node.arguments;
    if (argument && ts.isPropertyAccessExpression(argument)) {
      found = argument.name.text;
    }
  });
  return found;
}

function soleCallArgumentCallee(
  scope: ts.Node,
  calleeName: string
): string | null {
  let found: string | null = null;
  forEachNode(scope, (node) => {
    if (
      !(ts.isCallExpression(node) && ts.isIdentifier(node.expression)) ||
      node.expression.text !== calleeName
    ) {
      return;
    }
    const [argument] = node.arguments;
    if (
      argument &&
      ts.isCallExpression(argument) &&
      ts.isIdentifier(argument.expression)
    ) {
      found = argument.expression.text;
    }
  });
  return found;
}

/**
 * ISS-9701: the METHOD invoked inside a deps-object property handed to
 * `calleeName` — the `bar` of `f(x, { prop: () => deps.foo.bar() })` — with the
 * number of arguments that call passes, or `null` when the property is absent
 * or invokes nothing.
 *
 * The property NAME alone would not distinguish the fix from the bug: an
 * `onUnauthorized: () => undefined` keeps the key, keeps every bridge suite
 * green, and ships an install whose rejected token is re-sent until its local
 * expiry. What the composition root chooses to call is the fact only this file
 * can see.
 *
 * The ARGUMENT COUNT is here for the same reason one layer down. `rejectedToken`
 * is optional on the manager, so dropping it — `() => …invalidateAccessToken()`
 * — still typechecks, still calls the right method, and still passes every
 * assertion about the method's name, while restoring exactly the unconditional
 * eviction that lets a late 401 discard a freshly refreshed credential.
 */
function depsPropertyMethodCall(
  scope: ts.Node,
  calleeName: string,
  propertyName: string
): { name: string; argumentCount: number } | null {
  let found: { name: string; argumentCount: number } | null = null;
  forEachNode(scope, (node) => {
    if (
      !(ts.isCallExpression(node) && ts.isIdentifier(node.expression)) ||
      node.expression.text !== calleeName
    ) {
      return;
    }
    for (const argument of node.arguments) {
      if (!ts.isObjectLiteralExpression(argument)) {
        continue;
      }
      for (const property of argument.properties) {
        if (
          !(
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === propertyName
          )
        ) {
          continue;
        }
        forEachNode(property.initializer, (inner) => {
          if (
            ts.isCallExpression(inner) &&
            ts.isPropertyAccessExpression(inner.expression)
          ) {
            found = {
              name: inner.expression.name.text,
              argumentCount: inner.arguments.length,
            };
          }
        });
      }
    }
  });
  return found;
}

describe("desktop IPC registration wiring (ISS-5300)", () => {
  const source = parseTypeScriptFile(REGISTRATION_MODULE);
  const bootScope = registrationFunctionBody(source);

  test("every covered registrar is imported by the composition root", () => {
    const imported = importedNames(source);
    const missing = COVERED_REGISTRARS.filter((name) => !imported.has(name));
    assert.deepEqual(
      missing,
      [],
      `composition root does not import: ${missing.join(", ")}`
    );
  });

  for (const registrar of COVERED_REGISTRARS) {
    test(`${registrar} is invoked exactly once at boot`, () => {
      const calls = countDirectCalls(bootScope, registrar);
      // 0 => the handler group is dead: its own suite still passes while no
      // channel is registered in the running app.
      // >1 => registered twice; Electron's ipcMain.handle throws on a duplicate
      // channel, so the app fails at boot.
      assert.equal(
        calls,
        1,
        `${registrar} is called ${calls} time(s) in desktop-ipc-registration.ts; expected exactly 1`
      );
    });
  }

  test("the readiness projector's getters come from the tested builder, never a literal here (ISS-6206)", () => {
    // This guard used to read the property NAMES off an object literal passed
    // here and call that "wired to live getters". It was not: rewriting the
    // settings entry as `getTranscriptSyncEnabled: () => false`, or as a value
    // captured once at boot and returned from a thunk, kept the same three names
    // in the same order and left every suite green — while every install
    // reported the transcript lane `disabled_by_config`. A name is not a source.
    //
    // Both bindings are now executed by `cloud-read-readiness-projection.test.ts`
    // against a fake settings store. What only THIS file can see is that the
    // shipped app routes through that tested builder rather than re-deriving the
    // deps in a literal Electron alone can reach — so the assertion is exactly
    // that, and no longer overstates what a structural walk can prove.
    assert.ok(
      importedNames(source).has(PROJECTOR_DEPS_BUILDER),
      `composition root does not import ${PROJECTOR_DEPS_BUILDER}`
    );
    assert.equal(
      countDirectCalls(bootScope, "createCloudReadReadinessProjector"),
      1,
      "the readiness handler must come from the shared projector, not a second copy of its rules"
    );
    assert.equal(
      soleCallArgumentCallee(bootScope, "createCloudReadReadinessProjector"),
      PROJECTOR_DEPS_BUILDER,
      `the projector's deps must be built by ${PROJECTOR_DEPS_BUILDER}; an object literal here puts the binding back where no test can execute it`
    );
  });

  test("the no-lane transcript status is given this machine's identity, never a hardcoded null (ISS-7516)", () => {
    // Review cid 3836611089. The metadata data-sync level persists
    // `transcriptSyncEnabled` false, so `getTranscriptSync()` is null and EVERY
    // metadata-tier machine reads the no-lane snapshot. While this call site
    // passed a literal `null`, the renderer could never establish "this session
    // was recorded on THIS machine", `resolveTranscriptNeverExpected` returned
    // false for all of them, and the panel kept promising an upload that was
    // never queued — the exact conflation this ticket removes, surviving on the
    // one tier it was written for.
    //
    // Structural because it can only be seen here: the snapshot's own behaviour
    // is executed by `transcript-sync-lane-absent-status.test.ts`, and that
    // suite stays green for any argument the composition root chooses. Only the
    // ARGUMENT distinguishes the bug from the fix, so that is what is pinned.
    assert.ok(
      importedNames(source).has(LANE_ABSENT_STATUS),
      `composition root does not import ${LANE_ABSENT_STATUS}`
    );
    assert.equal(
      countDirectCalls(bootScope, LANE_ABSENT_STATUS),
      1,
      `${LANE_ABSENT_STATUS} must be the single source of the no-lane snapshot`
    );
    assert.equal(
      soleCallArgumentPropertyCallee(bootScope, LANE_ABSENT_STATUS),
      TRANSCRIPT_IDENTITY_DEP,
      `${LANE_ABSENT_STATUS} must be passed deps.${TRANSCRIPT_IDENTITY_DEP}(); a literal null makes the never-expected verdict unreachable on the metadata tier`
    );
  });

  test("the runtime and transcript-lane degradations come from the tested builders (ISS-8143)", () => {
    // Same shape as the ISS-6206 guard above, and for the same reason. Each of
    // these degradations used to be an inline closure here, so its
    // "degrade to null / [] / unavailable" comment was the only thing asserting
    // it. What only THIS file can see is that the shipped app routes through
    // the builders rather than re-deriving them in a literal Electron alone can
    // reach; what those builders actually DO is executed next door.
    // Each builder is counted in the function that actually calls it: the
    // progress getters at boot, the force-archive action inside the transcript
    // registrar the boot function delegates to. A single shared scope would
    // report one of them zero and pass only because the loop stopped early.
    for (const { builder, scope, source: sourceGetter } of [
      {
        builder: RUNTIME_PROGRESS_BUILDER,
        scope: bootScope,
        source: "getAgentDashboardRuntime",
      },
      {
        builder: PARSE_PROGRESS_BUILDER,
        scope: bootScope,
        source: "getAgentDashboardRuntime",
      },
      {
        builder: FORCE_SYNC_BUILDER,
        scope: namedFunctionBody(source, TRANSCRIPT_REGISTRATION_FUNCTION),
        source: "getTranscriptSync",
      },
    ]) {
      assert.ok(
        importedNames(source).has(builder),
        `composition root does not import ${builder}`
      );
      assert.equal(
        countDirectCalls(scope, builder),
        1,
        `${builder} must be the single source of its degradation, not one of two copies`
      );
      // The ARGUMENT, not just the call. Counting calls alone leaves
      // `${builder}(() => null)` green — which type-checks, and ships an install
      // that reports the degraded value forever.
      assert.equal(
        soleCallArgumentPropertyName(scope, builder),
        sourceGetter,
        `${builder} must be handed deps.${sourceGetter}; a literal or a thunk over something else makes the live source unreachable`
      );
    }
  });

  test("the cloud-API bridge drops a rejected token through the session manager (ISS-9701)", () => {
    // The bridge honors `onUnauthorized` when it is given one, and its own suite
    // proves that against a fake dep — but that suite stays green whether or not
    // the shipped app supplies the handler at all. Only the composition root
    // decides whether a desktop install actually re-mints after a 401, so the
    // wire itself is pinned here.
    assert.equal(
      countDirectCalls(bootScope, "registerCloudApiFetchIpcHandler"),
      1,
      "the cloud-API bridge must be registered exactly once at boot"
    );
    assert.deepEqual(
      depsPropertyMethodCall(
        bootScope,
        "registerCloudApiFetchIpcHandler",
        "onUnauthorized"
      ),
      { name: "invalidateAccessToken", argumentCount: 1 },
      "the bridge's 401 handler must drop the session manager's cached access token, and must name the rejected token when it does; without the handler the renderer's refresh-and-retry has nothing fresher to retry with, and without the token a late 401 evicts a credential the server never refused"
    );
  });

  test("desktop auth hands the sign-in handback the real window (ISS-10412)", () => {
    // `desktop-auth-ipc.test.ts` proves the handler calls `bringWindowToFront`
    // on a successful authorization — against a callback the TEST supplies. It
    // stays green whether or not the shipped app supplies one at all, which is
    // precisely the state that shipped: the browser said "return to the
    // Closedloop desktop app" and nothing brought it back.
    //
    // The property NAME alone would not be enough, for the reason the ISS-9701
    // guard above spells out: `bringWindowToFront: () => undefined` keeps the
    // key, keeps that suite green, and restores the bug. Which method the
    // composition root chooses to call is the fact only this file can see.
    assert.deepEqual(
      depsPropertyMethodCall(
        bootScope,
        "registerDesktopAuthIpcHandlers",
        "bringWindowToFront"
      ),
      { name: "returnFromBrowserSignIn", argumentCount: 0 },
      "the sign-in handback must show the desktop window; without this wire a successful browser authorization leaves the user in the browser, reading a page that tells them to return to an app that never comes forward"
    );
  });

  test("the counting walk sees call sites only — not prose, not imports", () => {
    // Guards the guard, and only where the loop above cannot. A name present in
    // the module solely as prose must count zero: `registerLogsActivityIpcHandlers`
    // is mentioned a third time in the :232-234 JSDoc, so a walk that ever
    // started reading comments would inflate counts and the exactly-once
    // assertions would keep passing for the wrong reason.
    assert.equal(countDirectCalls(bootScope, "deliberately"), 0);
    // Imported but never called from the boot function must also count zero —
    // an import alone is not wiring.
    assert.equal(countDirectCalls(bootScope, "WebContents"), 0);
  });
});
