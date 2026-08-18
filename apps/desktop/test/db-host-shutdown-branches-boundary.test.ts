/**
 * @file db-host-shutdown-branches-boundary.test.ts
 * @description ISS-5262 (closedloop-ai-stage review) — the shutdown
 * classification must SURVIVE the Branches sanitizing boundary.
 *
 * Every `desktop:shared-branches:*` handler is wrapped in `withDb`, whose catch
 * asks `isDbHostShutdownError` whether to resolve the payload-free sentinel
 * instead of rejecting. But `rethrowAsBranchSourceError` runs INSIDE the
 * handler, and it used to replace the db-host failure with a bare
 * `new Error(SHARED_BRANCHES_*_ERROR_CODE)` — so by the time `withDb`'s catch
 * ran the classification was gone, the answer was permanently `false`, and every
 * Branches read in flight at quit still rejected. `ipcMain.handle` then logged
 * `Error occurred in handler for '<channel>'` after `shutdown sequence end:
 * clean`, exactly the contradiction the ticket removes on the other channels.
 *
 * These drive the real boundary function and the real `withDb`, so deleting the
 * pass-through turns them red rather than leaving a green suite behind a
 * predicate nobody reaches.
 */
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { IpcMainInvokeEvent } from "electron";
import { rethrowAsBranchSourceError } from "../src/main/branch/branch-read-boundaries.js";
import { createDbIpcHandlerWrappers } from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import type { DbHostAgentDatabase } from "../src/main/database/sqlite.js";
import { DbHostExitError } from "../src/shared/db-host-exit-error.js";
import {
  DB_HOST_SHUTTING_DOWN_MESSAGE,
  DB_HOST_SHUTTING_DOWN_RESULT,
  isDbHostShuttingDownResult,
  rejectIfDbHostShuttingDown,
} from "../src/shared/db-host-shutdown-contract.js";
import {
  DbHostShutdownError,
  DbHostShutdownReason,
} from "../src/shared/db-host-shutdown-error.js";
import {
  SHARED_BRANCHES_SOURCE_ERROR_CODE,
  SHARED_BRANCHES_TRANSIENT_ERROR_CODE,
} from "../src/shared/shared-branches-contract.js";
import {
  extractDbHostErrorMessage,
  isTransientDbHostErrorMessage,
} from "../src/shared/transient-db-host-error.js";

const BRANCH_LABEL = "getSharedBranchDetail";

function fakeRuntimeOptions(
  isTrustedSender: AgentDashboardDesignSystemRuntimeOptions["isTrustedSender"] = () =>
    true
): AgentDashboardDesignSystemRuntimeOptions {
  return {
    getWindow: () => null,
    isTrustedSender,
    onTerminalFailure: () => {
      // unused
    },
  } as AgentDashboardDesignSystemRuntimeOptions;
}

/** A trusted `IpcMainInvokeEvent` stand-in; `withDb` reads only `event.sender`. */
function trustedEvent(): IpcMainInvokeEvent {
  return { sender: {} } as unknown as IpcMainInvokeEvent;
}

/** `withDb` over a handler that fails the way a real Branches read does. */
function branchHandlerRejecting(
  error: unknown,
  isTrustedSender?: AgentDashboardDesignSystemRuntimeOptions["isTrustedSender"]
): (event: IpcMainInvokeEvent) => Promise<unknown> {
  const { withDb } = createDbIpcHandlerWrappers({
    getAgentDatabase: () => Promise.resolve({} as DbHostAgentDatabase),
    options: fakeRuntimeOptions(isTrustedSender),
  });
  return withDb(() => {
    // The production shape: the read's own catch routes through the sanitizer.
    rethrowAsBranchSourceError(BRANCH_LABEL, error);
  });
}

test("a Branches read abandoned by the shutdown resolves the sentinel, not a rejection", async () => {
  const handler = branchHandlerRejecting(
    new DbHostShutdownError(
      DbHostShutdownReason.Exited,
      "db-host exited (code: 0)"
    )
  );

  const result = await handler(trustedEvent());

  assert.equal(
    isDbHostShuttingDownResult(result),
    true,
    "the sanitizer must not strip the classification withDb depends on"
  );
});

test("a genuine Branches failure still rejects with the sanitized code", async () => {
  const isTrustedSender = mock.fn(() => true);
  const handler = branchHandlerRejecting(
    new Error("SQLITE_ERROR: no such column: branches.bogus"),
    isTrustedSender
  );

  await assert.rejects(
    () => handler(trustedEvent()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        SHARED_BRANCHES_SOURCE_ERROR_CODE,
        "a real query failure must never be laundered into a shutdown"
      );
      return true;
    }
  );
  assert.equal(isTrustedSender.mock.calls.length, 1);
});

test("a mid-restart db-host blip still rejects with the TRANSIENT code", async () => {
  // Not a shutdown — the child crash-looping during backfill. This is the arm
  // the pass-through must not swallow: it has to keep reaching the existing
  // transient classification rather than resolving the shutdown sentinel.
  const handler = branchHandlerRejecting(
    new Error("db-host is not running (op: query)")
  );

  await assert.rejects(
    () => handler(trustedEvent()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, SHARED_BRANCHES_TRANSIENT_ERROR_CODE);
      return true;
    }
  );
});

test("a typed db-host exit is transient only while a restart is scheduled", async () => {
  for (const [restartScheduled, expectedCode] of [
    [true, SHARED_BRANCHES_TRANSIENT_ERROR_CODE],
    [false, SHARED_BRANCHES_SOURCE_ERROR_CODE],
  ] as const) {
    const handler = branchHandlerRejecting(
      new DbHostExitError(5, restartScheduled, "db-host exited (code: 5)")
    );

    await assert.rejects(
      () => handler(trustedEvent()),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, expectedCode);
        return true;
      }
    );
  }
});

/**
 * The renderer contract is what makes the pass-through safe. Today a shutdown
 * blip reaches `runSource` as `SHARED_BRANCHES_TRANSIENT_ERROR_CODE` and becomes
 * a quiet reconnecting state. Routed through the sentinel it arrives as
 * `DB_HOST_SHUTTING_DOWN_MESSAGE` instead — which must ALSO classify transient,
 * or the fix would trade a lying log for a hard error card.
 */
test("the sentinel's preload rejection still reads as a transient db-host error", () => {
  assert.throws(
    () =>
      // Spread, not the frozen singleton: recognition must be structural,
      // because the value the preload sees is a structured-clone COPY.
      rejectIfDbHostShuttingDown({ ...DB_HOST_SHUTTING_DOWN_RESULT }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, DB_HOST_SHUTTING_DOWN_MESSAGE);
      assert.equal(
        isTransientDbHostErrorMessage(error.message),
        true,
        "the renderer must keep routing this to the reconnecting surface"
      );
      return true;
    }
  );
});

/**
 * The classifier's own boundary arms. `rethrowAsBranchSourceError` reaches
 * `isTransientDbHostErrorMessage` through `extractDbHostErrorMessage`, and what
 * it hands over is an `unknown` rejection: an `Error`, a bare string thrown
 * across the utilityProcess boundary, or something with no readable message at
 * all. Each has to land somewhere deliberate — the boundary must never widen
 * "unreadable" into "transient", which would mask a real query failure as a
 * restart and quietly swallow it behind the reconnecting surface.
 */
test("a bare string rejection still reaches the transient classification", () => {
  const raw = "db-host is closed (op: query)";
  assert.equal(extractDbHostErrorMessage(raw), raw);
  assert.equal(
    isTransientDbHostErrorMessage(extractDbHostErrorMessage(raw)),
    true
  );
});

test("a rejection with no readable message fails CLOSED to a fatal read", () => {
  for (const opaque of [
    // A structured-clone COPY of an Error loses the prototype, so a plain object
    // that merely LOOKS like one must not be trusted as a lifecycle signature.
    { message: "db-host exited (code: 0)" },
    42,
    null,
    undefined,
  ]) {
    assert.equal(
      extractDbHostErrorMessage(opaque),
      null,
      `no message may be invented for ${JSON.stringify(opaque)}`
    );
    assert.equal(
      isTransientDbHostErrorMessage(extractDbHostErrorMessage(opaque)),
      false,
      "an unreadable rejection stays a hard error, never a masked restart"
    );
  }
});

test("an empty or absent message never classifies as a db-host restart", () => {
  for (const message of [null, undefined, ""]) {
    assert.equal(
      isTransientDbHostErrorMessage(message),
      false,
      `${JSON.stringify(message)} carries no lifecycle signature`
    );
  }
  // Non-vacuous contrast: a real lifecycle string DOES classify, and the match
  // is case-insensitive-substring so an IPC wrapper prefix still classifies.
  assert.equal(
    isTransientDbHostErrorMessage(
      "Error invoking remote method 'desktop:shared-branches:list': Error: DB-Host Exited"
    ),
    true
  );
});
