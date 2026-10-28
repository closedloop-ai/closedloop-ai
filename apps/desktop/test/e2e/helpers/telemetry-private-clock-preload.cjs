"use strict";

// Held experiment: only the already-qualified telemetry registration is virtual.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const {
  desktopFromMainArgs,
  createOwnerQualifier,
} = require("./telemetry-interval-owner.cjs");
const desktop = desktopFromMainArgs(process.argv);
const desktopRequire = createRequire(path.join(desktop, "package.json"));
const packageMetadata = JSON.parse(
  fs.readFileSync(
    path.join(desktop, "node_modules/@sinonjs/fake-timers/package.json"),
    "utf8"
  )
);
if (packageMetadata.version !== "15.4.0") {
  throw new Error("Telemetry trial requires exact locked fake-timers15.4.0.");
}
const FakeTimers = desktopRequire("@sinonjs/fake-timers");
const qualifyOwner = createOwnerQualifier(desktop);
const CADENCE_MS = 15_000;
const native = {
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  clearTimeout: globalThis.clearTimeout,
  Date: globalThis.Date,
};
const privateFacade = {
  Date: native.Date,
  Promise: globalThis.Promise,
  setTimeout: globalThis.setTimeout,
  clearTimeout: native.clearTimeout,
  setImmediate: globalThis.setImmediate,
  clearImmediate: globalThis.clearImmediate,
  setInterval: native.setInterval,
  clearInterval: native.clearInterval,
};
// createClock does not install globals; real Date and all external progress stay real.
const clock = FakeTimers.withGlobal(privateFacade).createClock(0);
let owner = null;
let advances = 0;
let actualCallbacks = 0;
let completionPending = false;
let lastCompletion = Promise.resolve({ fulfilled: true });
let advanceQueue = Promise.resolve();
const errors = [];
function fault(kind, error) {
  if (errors.length < 8) {
    errors.push({
      kind,
      name: error instanceof Error ? error.name : "non-error",
    });
  }
}
let foreignRegistrations = 0;
let cleared = false;
const started = process.hrtime.bigint();
const events = [];
let dropped = 0;
function record(event) {
  if (events.length >= 64) {
    dropped += 1;
    return;
  }
  events.push({
    elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
    ...event,
  });
}
function creatorStack() {
  const error = {};
  Error.captureStackTrace(error, routeRegistration);
  return String(error.stack || "");
}
function nativeLifecycleOnly() {}

function routeRegistration(target, thisArg, args) {
  const stack = creatorStack();
  const qualification = qualifyOwner(args[0], args[1], stack);
  if (!qualification) {
    foreignRegistrations += 1;
    return Reflect.apply(target, thisArg, args);
  }
  if (owner || args.length !== 2) {
    throw new Error("Telemetry trial requires one exact owned registration.");
  }
  const callbackSha256 = crypto
    .createHash("sha256")
    .update(Function.prototype.toString.call(args[0]))
    .digest("hex");
  // The private clock owns the unchanged arrow callback. The real Timeout owns
  // exactly the production-used ref/unref/cancel/liveness contract until stop().
  const nativeHandle = Reflect.apply(target, thisArg, [
    nativeLifecycleOnly,
    CADENCE_MS,
  ]);
  let virtualHandle;
  try {
    virtualHandle = clock.setInterval(function ownedPeriodicCallback() {
      actualCallbacks += 1;
      const completion = Reflect.apply(args[0], nativeHandle, []);
      if (!(completion instanceof privateFacade.Promise)) {
        throw new Error(
          "Returned periodic callback did not expose its original native completion promise."
        );
      }
      completionPending = true;
      // Consumption is test-owned: production Node still ignores this same return.
      lastCompletion = completion.then(
        () => {
          completionPending = false;
          record({
            kind: "actual-drain-finally-settled",
            ordinal: actualCallbacks,
          });
          return { fulfilled: true };
        },
        (error) => {
          completionPending = false;
          fault("original-drain-rejected", error);
          return { fulfilled: false };
        }
      );
      return completion;
    }, CADENCE_MS);
  } catch (error) {
    native.clearInterval(nativeHandle);
    throw error;
  }
  owner = { nativeHandle, virtualHandle, callbackSha256, qualification };
  record({
    kind: "qualified-owner-paired",
    callbackSha256,
    qualification,
    cadenceMs: CADENCE_MS,
    nativeHandleHasRefBeforeProductionUnref: nativeHandle.hasRef(),
    virtualHandleHasRef: virtualHandle.hasRef(),
  });
  return nativeHandle;
}

const setIntervalProxy = new Proxy(native.setInterval, {
  apply: routeRegistration,
});
const clearProxies = {};
for (const api of ["clearInterval", "clearTimeout"]) {
  clearProxies[api] = new Proxy(native[api], {
    apply(target, thisArg, args) {
      if (owner && args[0] === owner.nativeHandle) {
        clock.clearInterval(owner.virtualHandle);
        cleared = true;
        record({
          kind: "paired-owner-clear",
          api,
          hasRef: owner.nativeHandle.hasRef(),
          virtualTimersRemaining: clock.countTimers(),
        });
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
}
globalThis.setInterval = setIntervalProxy;
for (const api of Object.keys(clearProxies)) {
  globalThis[api] = clearProxies[api];
}

function snapshot() {
  return {
    qualification: owner?.qualification || null,
    callbackSha256: owner?.callbackSha256 || null,
    ownerRegistered: Boolean(owner),
    originalNativeHandleRetained: Boolean(owner),
    hasRef: owner?.nativeHandle.hasRef() ?? null,
    cleared,
    advances,
    actualCallbacks,
    completionPending,
    errors: errors.slice(),
    foreignRegistrations,
    virtualTimersRemaining: clock.countTimers(),
    dateIdentityUnchanged: globalThis.Date === native.Date,
    dropped,
    events: events.slice(),
  };
}

Object.defineProperty(globalThis, "__closedloopTelemetryTestClock", {
  configurable: true,
  value: Object.freeze({
    snapshot,
    requestOneCadence() {
      if (
        !owner ||
        cleared ||
        advances >= 2 ||
        actualCallbacks !== advances ||
        clock.countTimers() !== 1 ||
        owner.nativeHandle.hasRef()
      ) {
        throw new Error(
          "Held telemetry request requires one live, natively unref'ed owner and exact prior callback count."
        );
      }
      const priorCompletion = lastCompletion;
      const ordinal = ++advances;
      // Return immediately so the ORIGINAL HTTP observer's30s deadline starts.
      // A hung predecessor schedules no second period and that observer still fails.
      advanceQueue = advanceQueue
        .then(() => priorCompletion)
        .then((outcome) => {
          if (!outcome.fulfilled || cleared || errors.length) {
            throw new Error("Previous owned drain failed or was canceled.");
          }
          record({ kind: "advance-start-after-predecessor-finally", ordinal });
          return clock.tickAsync(CADENCE_MS);
        })
        .catch((error) => {
          fault("private-clock-advance", error);
        });
      return snapshot();
    },
  }),
});

process.once("exit", () => {
  const receipt = snapshot();
  // The canonical test launcher captures this bounded exit receipt before
  // cleanup resolves; no local file or manually prepared CI receipt is required.
  fs.writeSync(
    2,
    `CLOSEDLOOP_TELEMETRY_TEST_CLOCK ${JSON.stringify(receipt)}\n`
  );
  // Do not mask missing production cancellation by clearing the timer here.
  if (globalThis.setInterval === setIntervalProxy) {
    globalThis.setInterval = native.setInterval;
  }
  for (const api of Object.keys(clearProxies)) {
    if (globalThis[api] === clearProxies[api]) {
      globalThis[api] = native[api];
    }
  }
  Reflect.deleteProperty(globalThis, "__closedloopTelemetryTestClock");
});
