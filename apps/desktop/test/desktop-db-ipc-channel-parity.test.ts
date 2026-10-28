/**
 * @file desktop-db-ipc-channel-parity.test.ts
 * @description ISS-6712 — preload ↔ main-process parity for the db-host IPC
 * families: no orphan channel in EITHER direction.
 *
 * WHY IT NEEDS A GUARD. `apps/desktop/AGENTS.md` names this as the second of the
 * two invariants the retired `test/agent-dashboard-boundary.test.ts` checked and
 * that "neither is currently guarded". The two failure modes are asymmetric and
 * both are real:
 *
 *   - a preload bridge whose channel has no `ipcMain.handle` is a renderer call
 *     that rejects with "No handler registered" the first time a user reaches
 *     that screen — invisible to every unit test on either side of it;
 *   - a registered handler with no preload bridge is dead code holding a live
 *     `ipcMain` channel open. Nothing routes it, so nothing exercises it, and it
 *     drifts out of the security review that every REACHABLE channel gets.
 *
 * The second is the direction people leave out, so the assertion below is an
 * explicit set EQUALITY, checked and reported both ways.
 *
 * HOW — derived, never listed. ISS-6271 flags the shape this test must not
 * take: a literal channel list maintained in the suite, which drifts silently
 * and, once stale, asserts that the code matches a copy of itself. So both sets
 * are read out of the shipped modules by running them:
 *
 *   - the PRELOAD set is the object `preload-design-system.ts` actually hands
 *     `contextBridge.exposeInMainWorld("desktopApi", …)` — the same object the
 *     renderer receives. Every function on it is called, and the channels the
 *     recording `ipcRenderer` sees are the answer. Delete a bridge method and
 *     its channel leaves the set.
 *   - the HANDLER set is whatever `registerDesignSystemDbIpcHandlers` registers
 *     when it is run. Delete a registration, or a whole group registrar, and its
 *     channels leave the set.
 *
 * Both modules import `electron` at module scope, so `electron` is mocked with
 * the shared recording double in `helpers/electron-module-stub.ts`. `node:module`
 * is mocked as well and for one reason only: `preload-common.ts` resolves
 * Electron through `createRequire(import.meta.url)("electron")` rather than a
 * static import, which no module mock reaches otherwise — and that call is what
 * produces the `contextBridge` the whole preload derivation reads from.
 *
 * SCOPE. The db-host families (`DbGuardedChannel`) only. The preload also
 * bridges ~100 channels registered by `app.ts`, which statically imports
 * `electron` in a graph that cannot be booted here; those are out of scope and
 * the scope itself is asserted below, so a NEW db-host family cannot quietly
 * fall outside it.
 */

import assert from "node:assert/strict";
import { beforeAll, test, vi } from "vitest";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import type { DbHostAgentDatabase } from "../src/main/database/sqlite.js";
import type { DbGuardedChannel } from "../src/shared/db-host-shutdown-contract.js";
import { createIpcRegistrar } from "./helpers/ipc-registrar.js";

vi.mock("electron", async () => {
  const stub = await import("./helpers/electron-module-stub.js");
  return { ...stub, default: stub.default };
});

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  const stub = await import("./helpers/electron-module-stub.js");
  return {
    ...actual,
    createRequire: (from: string | URL) => {
      const required = actual.createRequire(from);
      return new Proxy(required, {
        apply: (_target, _thisArg, args: unknown[]) =>
          args[0] === "electron"
            ? stub
            : Reflect.apply(required, undefined, args as [string]),
      });
    },
  };
});

/**
 * The channel-name prefixes of the db-host families.
 *
 * `satisfies readonly DbGuardedChannel[]` is the compile-time half: every entry
 * must be a prefix the production `DbGuardedChannel` union actually recognizes,
 * so a typo or a renamed family fails `tsc` rather than quietly narrowing this
 * suite's scope to nothing. The COMPLETENESS half — that no db-host family is
 * missing from this list — cannot be expressed in the type system, so it is
 * asserted at runtime against the registered handler set below.
 */
const GUARDED_CHANNEL_PREFIXES = [
  "desktop:db:",
  "desktop:shared-agent-sessions:",
  "desktop:shared-branches:",
] as const satisfies readonly DbGuardedChannel[];

const MAIN_WORLD_KEY = "desktopApi";

/**
 * Explicit, generous hook timeout — NOT a raised bound hiding a hang.
 *
 * The setup below imports the real preload entrypoint and the real db-host
 * registration pass, which is a large production module graph the runner has to
 * transform once. That costs ~30s on an idle machine and was measured at ~130s
 * on a loaded one, which overruns the suite-wide 120s default for a reason that
 * has nothing to do with the contract under test. Nothing here waits on a timer,
 * a socket, or a poll, so a genuine hang cannot be absorbed by this number — it
 * would run out the clock at any value.
 */
const SETUP_TIMEOUT_MS = 300_000;

let preloadChannels: ReadonlySet<string>;
let handlerChannels: ReadonlySet<string>;
let bridgesThatThrew: readonly string[];
let bridgesThatRejectedUnnamed: readonly string[];
let shadowedChannels: readonly string[];

beforeAll(async () => {
  const stub = await import("./helpers/electron-module-stub.js");
  stub.resetElectronModuleStub();

  // Importing the preload entrypoint IS the production exposure: the module
  // builds its bridge object and calls `exposeDesktopApi` at module scope.
  await import("../src/main/preload-design-system.js");
  const derivation = await callEveryFunction(
    stub.exposedMainWorldApi(MAIN_WORLD_KEY),
    () => stub.rendererInvokeChannels().length
  );
  bridgesThatThrew = derivation.threw;
  bridgesThatRejectedUnnamed = derivation.rejectedBeforeNamingAChannel;
  preloadChannels = new Set(
    stub.rendererInvokeChannels().filter(isGuardedChannel)
  );

  const registration = await import(
    "../src/main/dashboard/agent-dashboard-db-ipc-registration.js"
  );
  registration.registerDesignSystemDbIpcHandlers(
    () => Promise.resolve({} as DbHostAgentDatabase),
    runtimeOptionsDouble(),
    () => Promise.resolve(undefined),
    () => {
      // ISS-9802: this suite derives CHANNELS, not behaviour — the cancel
      // forward is driven for real in `desktop-read-cancellation.test.ts`.
    }
  );
  handlerChannels = new Set(stub.registeredInvokeChannels());
  shadowedChannels = stub.duplicateRegisteredChannels();
}, SETUP_TIMEOUT_MS);

test("ISS-6712: no db-host channel is registered twice", () => {
  // `handlerChannels` is a Set over a Map's keys, so a channel registered by two
  // different group registrars inside `registerDesignSystemDbIpcHandlers` shows
  // up exactly once and looks correct here — while the LATER registration has
  // silently replaced the earlier one. If the two differ in what they enforce
  // (one applying the `withDb` guard, one not), that is a live channel whose
  // protections were swapped out with no assertion able to see it. Real Electron
  // throws on this at boot; the stub records it so it fails here first.
  assert.deepEqual(
    [...shadowedChannels],
    [],
    `these channels were registered more than once, so only the last handler survives and the earlier one is unreachable: ${shadowedChannels.join(", ")}.`
  );
});

test("ISS-6712: both channel sets were actually derived", () => {
  // The floor under every assertion in this file. A walk that reached nothing,
  // a preload that failed to expose, or a registration pass that registered
  // nothing would make the equality below trivially true — two empty sets are
  // equal — so each family must be represented on BOTH sides before any
  // comparison means anything.
  for (const prefix of GUARDED_CHANNEL_PREFIXES) {
    assert.ok(
      [...preloadChannels].some((channel) => channel.startsWith(prefix)),
      `no preload bridge invoked a "${prefix}*" channel — the exposed-api walk did not reach this family, so a comparison over it proves nothing`
    );
    assert.ok(
      [...handlerChannels].some((channel) => channel.startsWith(prefix)),
      `no handler registered a "${prefix}*" channel — the registration pass did not reach this family, so a comparison over it proves nothing`
    );
  }
});

test("ISS-6712: no exposed bridge threw before it could name its channel", () => {
  // The other way a comparison over a channel can prove nothing, and unlike the
  // empty-set case above it is INVISIBLE to the anchor: one bridge, not one
  // family, drops out.
  //
  // `callEveryFunction` invokes with no arguments. A bridge that destructures
  // its parameter or guards before invoking throws, names no channel, and so is
  // absent from `preloadChannels`. When that channel HAS a handler the loss is
  // self-correcting — it resurfaces as a handler-orphan below. When it does NOT,
  // which is the first failure mode this file names, the channel is missing from
  // BOTH sides and every equality assertion goes green on the exact defect it
  // exists to catch. Naming the thrower here is what keeps that from happening.
  assert.deepEqual(
    [...bridgesThatThrew],
    [],
    `these exposed bridges threw when called with no arguments, so no channel was recorded for them and they are silently absent from the preload set: ${bridgesThatThrew.join(", ")}. Give the walk an argument shape it can call, or the parity comparison below says nothing about these channels.`
  );
});

test("ISS-6712: no exposed bridge rejected before it could name its channel", () => {
  // The `async` twin of the test above, and the reason that one is not enough.
  //
  // `callEveryFunction` invokes with no arguments, and the guard next to this
  // one catches the bridge that THROWS on that. But `async` converts exactly
  // that throw into a rejected promise: an `async ({ cursor }) => …` bridge, or
  // one that validates its argument before invoking, leaves the walk's `catch`
  // untouched. Nothing throws, nothing is recorded, no channel is named — and a
  // rejection that is merely swallowed leaves NO trace at all, so the bridge
  // drops out of `preloadChannels` looking exactly like a bridge that was never
  // written. Pair that with the missing handler and the missing contract-list
  // entry and the channel is absent from every set this file compares: the
  // orphan is real, the renderer gets "No handler registered" the first time
  // that surface opens, and all eight assertions here report green.
  //
  // Detected as a rejection that named NOTHING rather than as a rejection,
  // because the stub's `invoke` resolves: a bridge that named its channel and
  // then rejected handling the reply has already given this suite everything it
  // reads. See `callOneBridge`.
  assert.deepEqual(
    [...bridgesThatRejectedUnnamed],
    [],
    `these exposed bridges returned a promise that REJECTED without ever reaching ipcRenderer.invoke, so no channel was recorded for them and they are silently absent from the preload set: ${bridgesThatRejectedUnnamed.join(", ")}. An async bridge that destructures or validates its argument does this when called with no arguments. Give the walk an argument shape it can call, or the parity comparison below says nothing about these channels.`
  );
});

test("ISS-6712: every db-host handler is in a family this suite scopes", () => {
  // The completeness half of the scope. `preloadChannels` is filtered by
  // GUARDED_CHANNEL_PREFIXES, so a new db-host family that nobody added to that
  // list would be dropped from the preload side and the equality test would
  // report every one of its channels as handler-only. This names the real cause
  // instead, and it is the only thing standing between a narrowed scope and a
  // guard that quietly stops covering a family.
  const unscoped = [...handlerChannels].filter(
    (channel) => !isGuardedChannel(channel)
  );
  assert.deepEqual(
    unscoped,
    [],
    `registerDesignSystemDbIpcHandlers registered channels outside every prefix in GUARDED_CHANNEL_PREFIXES: ${unscoped.join(", ")}. Add the family's prefix there (and to DbGuardedChannel) so the preload side is compared over it too.`
  );
});

test("ISS-6712: the scoped prefixes cover every declared db-host channel", async () => {
  // The test above reads the REGISTERED set, so it can only see a family that
  // someone actually wired into `registerDesignSystemDbIpcHandlers`. A family
  // that is declared and BRIDGED but whose handler registration was forgotten is
  // invisible to it: nothing registers, so `unscoped` is empty, while the
  // preload side silently prefix-filters the new channels away — both sides
  // green on the orphan this file exists to catch.
  //
  // These five lists are the production declaration of the db-host surface;
  // `unregisterDesignSystemDbIpcHandlers` and the disabled-mode installer both
  // walk them, so reading them here is not the suite comparing the code to a
  // copy of itself. Anything they declare must fall inside the scope.
  // Imported here rather than at module scope for the same reason the
  // disabled-mode test below does it: `agent-dashboard-ipc-contract.js` reaches
  // `electron`, so it must not be resolved before `vi.mock` has installed the
  // stub.
  const contract = await import(
    "../src/main/dashboard/agent-dashboard-ipc-contract.js"
  );
  const agentSessions = await import(
    "../src/shared/shared-agent-sessions-contract.js"
  );
  const branches = await import("../src/shared/shared-branches-contract.js");
  const declared: string[] = [
    ...contract.DESIGN_SYSTEM_DB_IPC_CHANNELS,
    ...agentSessions.SHARED_AGENT_SESSIONS_IPC_CHANNEL_LIST,
    ...branches.SHARED_BRANCHES_IPC_CHANNEL_LIST,
  ];
  assert.ok(
    declared.length > 0,
    "the production db-host channel lists are empty — nothing below is being checked"
  );
  const outside = declared.filter((channel) => !isGuardedChannel(channel));
  assert.deepEqual(
    outside,
    [],
    `these channels are declared by the production db-host lists but match no prefix in GUARDED_CHANNEL_PREFIXES: ${outside.join(", ")}. Add the family's prefix there (and to DbGuardedChannel), or this suite silently stops comparing it on BOTH sides.`
  );
});

test("ISS-6712: no preload channel is missing its main-process handler", () => {
  const orphans = [...preloadChannels]
    .filter((channel) => !handlerChannels.has(channel))
    .sort();
  assert.deepEqual(
    orphans,
    [],
    `the preload exposes these db-host channels with no ipcMain handler: ${orphans.join(", ")}. A renderer that calls one rejects with "No handler registered for ..." the first time the surface is opened.`
  );
});

test("ISS-6712: the disabled-mode responder covers exactly the live handler set", async () => {
  // The db-host families have a SECOND production registration path:
  // `installDisabledAgentDashboardDbIpcHandlers` (wired from `app.ts` whenever
  // the Agent Dashboard is disabled or stopped) installs a neutral responder on
  // each channel by walking hand-maintained channel LISTS, not the live
  // registrar. So a channel added to a group registrar but forgotten in those
  // lists passes every assertion above — both sides of that comparison are
  // derived — while a user who disables the dashboard and opens the surface gets
  // "No handler registered" instead of the intended empty state.
  //
  // `agent-dashboard-disabled-ipc.test.ts` iterates the same lists the installer
  // iterates, so it cannot see that drift either. This is the assertion that
  // can: run the real installer and compare its channels to the live set.
  const contract = await import(
    "../src/main/dashboard/agent-dashboard-ipc-contract.js"
  );
  const harness = createIpcRegistrar();
  contract.installDisabledAgentDashboardDbIpcHandlers(harness.registrar);

  assert.deepEqual(
    harness.channels().sort(),
    [...handlerChannels].sort(),
    "the disabled-mode responder and the live registrar must cover the same db-host channels — a channel in one and not the other either loses its neutral disabled response or holds a disabled responder for a channel that no longer exists"
  );
});

test("ISS-6712: no main-process handler is missing its preload channel", () => {
  // The direction that is usually left out. It goes green forever while dead
  // handlers accumulate, because nothing downstream of an unreachable channel
  // ever fails.
  const orphans = [...handlerChannels]
    .filter((channel) => !preloadChannels.has(channel))
    .sort();
  assert.deepEqual(
    orphans,
    [],
    `these db-host channels have an ipcMain handler no preload bridge reaches: ${orphans.join(", ")}. Either bridge them or unregister them — an unroutable handler holds a live IPC channel that no security review covers.`
  );
});

function isGuardedChannel(channel: string): boolean {
  return GUARDED_CHANNEL_PREFIXES.some((prefix) => channel.startsWith(prefix));
}

/**
 * Call every function reachable on the exposed api, so each bridge names its
 * channel to the recording `ipcRenderer`, and report the ones that threw before
 * they got that far.
 *
 * Arguments are deliberately omitted: every bridge in this family is a
 * pass-through to `ipcRenderer.invoke(channel, ...args)`, so the channel is
 * named before any argument is read.
 *
 * A FAILURE TO NAME A CHANNEL IS NOT SWALLOWED, and that is the whole point of
 * the two returned lists. A bridge that destructures its parameter
 * (`({ cursor }) => …`) or guards before invoking never reaches `invoke` when
 * called with no arguments, and losing that quietly would drop its channel out
 * of `preloadChannels`. That is only self-correcting when the channel HAS a
 * handler — it then surfaces as a handler-orphan. In the failure mode this suite
 * names first, a preload channel with NO handler, the channel would be absent
 * from both sides and every comparison below would go green on exactly the
 * defect it exists to catch.
 *
 * Which of the two lists a bridge lands in is decided by whether it is `async`,
 * not by how badly it failed — a synchronous bridge throws, an `async` one
 * rejects — so BOTH are asserted empty, each by its own test. See
 * {@link callOneBridge} for why the rejecting case is detected by a channel
 * delta rather than by the rejection alone.
 */
async function callEveryFunction(
  api: Record<string, unknown>,
  namedChannelCount: () => number
): Promise<BridgeDerivationFailures> {
  const seen = new WeakSet<object>();
  const threw: string[] = [];
  const rejectedBeforeNamingAChannel: string[] = [];
  const walk = async (
    node: Record<string, unknown>,
    path: string
  ): Promise<void> => {
    if (seen.has(node)) {
      return;
    }
    seen.add(node);
    for (const [key, value] of Object.entries(node)) {
      const here = path ? `${path}.${key}` : key;
      if (typeof value === "function") {
        const outcome = await callOneBridge(
          value as (...args: unknown[]) => unknown,
          namedChannelCount
        );
        if (outcome === "threw") {
          threw.push(here);
        }
        if (outcome === "rejected-before-naming-a-channel") {
          rejectedBeforeNamingAChannel.push(here);
        }
        continue;
      }
      if (value !== null && typeof value === "object") {
        await walk(value as Record<string, unknown>, here);
      }
    }
  };
  await walk(api, "");
  return {
    threw: threw.sort(),
    rejectedBeforeNamingAChannel: rejectedBeforeNamingAChannel.sort(),
  };
}

/**
 * Call one bridge with no arguments and classify what it did about naming a
 * channel.
 *
 * THE ASYNC CASE IS WHY THIS MEASURES A DELTA RATHER THAN CATCHING. `async`
 * turns the throw this walk relies on into a REJECTION: an `async ({ cursor })
 * => …` bridge, or one that validates before invoking, does not enter the
 * `catch` above, so a caught-throws-only guard records neither a thrower nor a
 * channel and the bridge vanishes from the preload set without a trace. When
 * that channel also has no handler and no contract-list entry, it is absent from
 * BOTH derived sets and every equality assertion in this file goes green on
 * precisely the orphan it exists to catch.
 *
 * A rejection ALONE is not the signal, which is what keeps this from flagging
 * healthy bridges: `ipcRenderer.invoke` is a pass-through that resolves here, so
 * a bridge that named its channel and then rejected while handling the stub's
 * `undefined` reply has still contributed everything this suite reads from it.
 * The failure is a rejection that named NOTHING — the pre-invoke rejection — so
 * the recorded-channel count is read on both sides of the call and the two are
 * compared.
 *
 * Settled SEQUENTIALLY by the caller's `await`, because that delta is only
 * attributable to this bridge while no other bridge is in flight. Nothing here
 * waits on a timer or a socket: the stub's `invoke` resolves immediately, so a
 * promise that never settles is a bridge awaiting something this harness does
 * not provide, which is a derivation failure that should stop the suite rather
 * than be absorbed.
 */
async function callOneBridge(
  bridge: (...args: unknown[]) => unknown,
  namedChannelCount: () => number
): Promise<BridgeOutcome> {
  const before = namedChannelCount();
  let result: unknown;
  try {
    result = bridge();
  } catch {
    return "threw";
  }
  if (!(result instanceof Promise)) {
    return "ok";
  }
  const rejected = await result.then(
    () => false,
    () => true
  );
  if (rejected && namedChannelCount() === before) {
    return "rejected-before-naming-a-channel";
  }
  return "ok";
}

/**
 * The runtime options `registerDesignSystemDbIpcHandlers` is handed.
 *
 * Registration captures this object into the handler closures and reads nothing
 * off it while registering, so a double that answers every field with a no-op is
 * enough to run the real pass. Nothing here is invoked — this suite reads the
 * channel NAMES a registration produces, never a handler's behavior.
 */
function runtimeOptionsDouble(): AgentDashboardDesignSystemRuntimeOptions {
  return new Proxy(
    {},
    {
      get: () => () => undefined,
    }
  ) as AgentDashboardDesignSystemRuntimeOptions;
}

/** What one bridge did about naming its channel. See {@link callOneBridge}. */
type BridgeOutcome = "ok" | "threw" | "rejected-before-naming-a-channel";

/**
 * The bridges the preload derivation could not read a channel out of, split by
 * how they failed.
 *
 * Two lists rather than one because the two are told apart only by whether the
 * bridge is `async`, and a reader who sees an empty `threw` should not conclude
 * the walk reached every bridge.
 */
type BridgeDerivationFailures = {
  threw: readonly string[];
  rejectedBeforeNamingAChannel: readonly string[];
};
