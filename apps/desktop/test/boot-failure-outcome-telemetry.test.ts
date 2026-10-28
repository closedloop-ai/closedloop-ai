/**
 * @file boot-failure-outcome-telemetry.test.ts
 * @description ISS-9259 — the axis that separates an install that RECOVERED
 * from one that stayed dark.
 *
 * ISS-9197 gave a store-open deadline a retry ladder and, correctly, reports a
 * ladder that clears — so an install whose second attempt succeeded is not
 * invisible. That report carries `store_open_timeout`, the same kind the
 * exhaustion carries, because the monitor that counts the kind is the one that
 * has to see the recovery. One kind therefore described two opposite outcomes,
 * and Datadog monitor 319264706 counts DISTINCT INSTALLS per release and goes
 * critical at two: measured on the real span index on 2026-09-08, release
 * 0.16.1855 reported a cardinality of 2 with one of the two merely recovered.
 *
 * So every case here is about DISAGREEMENT on one axis while the other agrees.
 * A case that only proved "a recovery carries an outcome" would stay green if
 * both paths emitted the same one, which is the conflation this closes.
 */

import { AppTelemetrySchema } from "@closedloop-ai/telemetry-contract/app";
import {
  AppBootFailureKind,
  AppBootFailureOutcome,
} from "@closedloop-ai/telemetry-contract/app-boot-failure-kind";
import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { bootstrapAgentDashboardRuntime } from "../src/main/dashboard/agent-dashboard-runtime-bootstrap.js";
import { sanitizeDesktopException } from "../src/shared/exception-sanitizer.js";
import {
  bootstrapDeps,
  storeOpenTimeoutError,
} from "./agent-dashboard-bootstrap-fixture.js";

/**
 * The outcome literals as the monitor query spells them, written out here rather
 * than read off `AppBootFailureOutcome`. A fixture read off the union under test
 * cannot fail when a member is renamed — it compares a moved value with itself.
 */
const RECOVERED = "recovered";
const FAILED = "failed";

const OPENED_RUNTIME = { opened: true };

const createRuntime = vi.fn();

// The runtime module is dynamically imported by the boot path and pulls in the
// whole SQLite/db-host stack; mocking it is what lets the REAL bootstrap
// function run its retry loop and its REAL emit sites in this lane.
vi.mock(
  "../src/main/dashboard/agent-dashboard-design-system-runtime.js",
  () => ({
    createAgentDashboardDesignSystemRuntime: createRuntime,
  })
);

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/boot-failure-outcome-telemetry" },
  Notification: class {
    show() {
      return undefined;
    }
  },
}));

beforeEach(() => {
  createRuntime.mockReset();
});

type EmittedException = {
  error: Error;
  bootFailureKind: string;
  bootFailureOutcome?: string;
};

/**
 * Drive the REAL boot path and hand back every app-exception input it emitted.
 *
 * The array rather than the first element: "how many" is half of what these
 * cases assert, and a helper that returned `calls[0][0]` would let a second
 * emit through unnoticed. The assertions stay in the cases, never in here.
 */
async function emitsFromBoot(): Promise<EmittedException[]> {
  const emitAppExceptionEvent = vi.fn();
  await bootstrapAgentDashboardRuntime(
    bootstrapDeps({
      emitAppExceptionEvent,
      sleepBeforeStoreOpenRetry: () => Promise.resolve(),
    })
  );
  return emitAppExceptionEvent.mock.calls.map(
    (call) => call[0] as EmittedException
  );
}

describe("ISS-9259 — the boot path separates the two outcomes", () => {
  test("a ladder that CLEARS reports recovered", async () => {
    createRuntime
      .mockRejectedValueOnce(storeOpenTimeoutError())
      .mockResolvedValueOnce(OPENED_RUNTIME);

    const emitted = await emitsFromBoot();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.bootFailureOutcome).toBe(RECOVERED);
  });

  test("a ladder that EXHAUSTS reports failed on the same kind", async () => {
    // The positive sibling the exclusion needs. A monitor that dropped every
    // store-open timeout would satisfy the recovered case above on its own and
    // would also stop reporting the outage ISS-9197 was written for.
    createRuntime.mockRejectedValue(storeOpenTimeoutError());

    const emitted = await emitsFromBoot();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.bootFailureOutcome).toBe(FAILED);
  });

  test("the two disagree on outcome while agreeing on kind", async () => {
    createRuntime
      .mockRejectedValueOnce(storeOpenTimeoutError())
      .mockResolvedValueOnce(OPENED_RUNTIME);
    const [recovered] = await emitsFromBoot();

    createRuntime.mockReset();
    createRuntime.mockRejectedValue(storeOpenTimeoutError());
    const [failed] = await emitsFromBoot();

    // Agreement on the kind is not incidental — it is why the outcome had to
    // exist. Letting the kinds differ here would prove nothing about the axis
    // under test, because the kind alone would then separate them.
    expect(recovered?.bootFailureKind).toBe(
      AppBootFailureKind.StoreOpenTimeout
    );
    expect(failed?.bootFailureKind).toBe(recovered?.bootFailureKind);
    expect(recovered?.bootFailureOutcome).not.toBe(failed?.bootFailureOutcome);
  });

  test("a non-timeout boot failure still carries failed", async () => {
    // The outcome is a property of WHICH emit site ran, not of the store-open
    // classification, so every terminal boot failure carries it — a packaging
    // break must not arrive with a missing outcome that a consumer would read
    // as "an older producer".
    createRuntime.mockRejectedValue(new Error("SQLITE_BUSY"));

    const emitted = await emitsFromBoot();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.bootFailureKind).toBe(AppBootFailureKind.Unknown);
    expect(emitted[0]?.bootFailureOutcome).toBe(FAILED);
  });
});

describe("ISS-9259 — the strict-schema boundary", () => {
  test("a recovered record survives the .strict() parse the emitter runs", () => {
    // `emitExceptionSpan` hands this exact object to `AppTelemetrySchema.parse`.
    // An undeclared key does not drop the ATTRIBUTE, it drops the WHOLE span —
    // which on this record is the recovery report itself.
    const attributes = sanitizeDesktopException({
      error: new Error(
        "Agent Monitor runtime recovered from a store open deadline on attempt 2 of 3"
      ),
      origin: AppExceptionOrigin.Main,
      bootFailureKind: AppBootFailureKind.StoreOpenTimeout,
      bootFailureOutcome: AppBootFailureOutcome.Recovered,
    });

    expect(attributes[TelemetryAttribute.AppBootFailureOutcome]).toBe(
      RECOVERED
    );
    expect(AppTelemetrySchema.parse(attributes)).toEqual(attributes);
  });

  test("an older producer's record omits the key rather than nulling it", () => {
    // The cross-repo shape: an installed desktop that predates this emits the
    // kind and no outcome. The field must be ABSENT, not `null` — a null fails
    // the enum and would drop the whole span, and a consumer must read absence
    // as "not classified" rather than as `failed`, which would count a
    // pre-ISS-9259 build's RECOVERED timeout as a dead install.
    const attributes = sanitizeDesktopException({
      error: new Error("Agent Monitor runtime failed to initialize"),
      origin: AppExceptionOrigin.Main,
      bootFailureKind: AppBootFailureKind.StoreOpenTimeout,
    });

    expect(TelemetryAttribute.AppBootFailureOutcome in attributes).toBe(false);
    expect(AppTelemetrySchema.parse(attributes)).toEqual(attributes);
  });

  test("the schema refuses an outcome outside the closed pair", () => {
    expect(
      AppTelemetrySchema.safeParse({
        [TelemetryAttribute.AppBootFailureOutcome]: "retried",
      }).success
    ).toBe(false);
  });
});
