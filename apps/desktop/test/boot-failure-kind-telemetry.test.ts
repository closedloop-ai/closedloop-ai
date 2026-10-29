/**
 * @file boot-failure-kind-telemetry.test.ts
 * @description ISS-8907 — the dimension that separates a fleet-wide Agent
 * Monitor boot failure from a one-off local one.
 *
 * ISS-4714 stripped the message and stack from this record for cardinality and
 * leak reasons, which was right, and left every non-refusal boot failure
 * arriving as one indistinguishable event. ISS-8906 is what that cost: six
 * installs on one build went dark and the mechanism had to be read off a local
 * log file. These tests are about DISTINCTNESS — that two different underlying
 * failures produce two different kinds — not about a `kind` field being present,
 * which the flattening this ticket exists to fix would satisfy just as well.
 */

import { AppTelemetrySchema } from "@closedloop-ai/telemetry-contract/app";
import { AppBootFailureKind } from "@closedloop-ai/telemetry-contract/app-boot-failure-kind";
import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { describe, expect, test, vi } from "vitest";
import { bootstrapAgentDashboardRuntime } from "../src/main/dashboard/agent-dashboard-runtime-bootstrap.js";
import {
  buildMigrationFailureTelemetryError,
  classifyBootFailureKind,
  DesktopMigrationError,
  MigrationRefusalKind,
} from "../src/main/lifecycle/migration-refusal.js";
import {
  SANITIZED_EXCEPTION_ATTRIBUTE_KEY_PRESENCE,
  sanitizeDesktopException,
} from "../src/shared/exception-sanitizer.js";
import {
  bootstrapDeps,
  storeOpenTimeoutError,
} from "./agent-dashboard-bootstrap-fixture.js";

/**
 * The kinds this contract publishes, spelled out here rather than read off
 * `AppBootFailureKind`. A test that enumerates the const it polices cannot fail
 * when a member is deleted — it just checks a shorter list against itself.
 */
const EXPECTED_BOOT_FAILURE_KINDS = [
  "migration_refusal",
  "module_resolution",
  "store_open_timeout",
  "unknown",
] as const;

const createRuntime = vi.fn();

// The runtime module is dynamically imported by the boot path and pulls in the
// whole SQLite/db-host stack; mocking it is what lets the REAL bootstrap
// function run its failure branch in this lane.
vi.mock(
  "../src/main/dashboard/agent-dashboard-design-system-runtime.js",
  () => ({
    createAgentDashboardDesignSystemRuntime: createRuntime,
  })
);

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/boot-failure-kind-telemetry" },
  Notification: class {
    show() {
      return undefined;
    }
  },
}));

/** The ISS-8906 shape: a packaging break, thrown by the ESM resolver. */
function moduleResolutionError(): Error {
  const error = new Error("Cannot find module 'electron' imported from /app");
  return Object.assign(error, { code: "ERR_MODULE_NOT_FOUND" });
}

describe("ISS-8907 — the boot-failure kind", () => {
  test("publishes exactly the four kinds, so deleting one fails here", () => {
    expect(Object.values(AppBootFailureKind).toSorted()).toEqual([
      ...EXPECTED_BOOT_FAILURE_KINDS,
    ]);
  });

  test("gives a packaging break and a migration refusal DIFFERENT kinds", () => {
    // The whole defect: before this, both of these reached Datadog as the same
    // event. Asserting a `kind` exists would not have caught that; asserting the
    // two disagree is the only assertion the flattening cannot satisfy.
    const packagingBreak = classifyBootFailureKind(moduleResolutionError());
    const refusal = classifyBootFailureKind(
      new DesktopMigrationError(
        MigrationRefusalKind.ChecksumDrift,
        "checksum drift on 0099_from_the_future"
      )
    );
    // ISS-9197: the fourth member, and the one that matters most to keep
    // distinct from `unknown` — it is the only kind here a reader should expect
    // to see recover, so folding it into the catch-all would read as an
    // unexplained failure on an install that is fine.
    const openTimeout = classifyBootFailureKind(storeOpenTimeoutError(600_000));
    const other = classifyBootFailureKind(new Error("SQLITE_BUSY"));

    expect(packagingBreak).toBe("module_resolution");
    expect(refusal).toBe("migration_refusal");
    expect(openTimeout).toBe("store_open_timeout");
    expect(other).toBe("unknown");
    expect(new Set([packagingBreak, refusal, openTimeout, other]).size).toBe(4);
  });

  test("classifies the CJS resolver spelling as the same packaging break", () => {
    // Which of the two Node throws is a bundling detail of the main entry, not a
    // signal — a build that flips to CJS must not silently start reporting
    // `unknown` for the failure it was reporting as a packaging break.
    const cjs = Object.assign(new Error("Cannot find module 'electron'"), {
      code: "MODULE_NOT_FOUND",
    });
    expect(classifyBootFailureKind(cjs)).toBe("module_resolution");
  });

  test("does not read the MESSAGE, so a lookalike message stays unknown", () => {
    // The classification must key on the Node `code` and nothing else: reading
    // the message is what would let a path or a specifier back into the record.
    const lookalike = new Error("Cannot find module 'electron'");
    expect(classifyBootFailureKind(lookalike)).toBe("unknown");
  });

  test("a non-Error rejection is classified, not crashed on", () => {
    expect(classifyBootFailureKind("boom")).toBe("unknown");
    expect(classifyBootFailureKind(undefined)).toBe("unknown");
  });
});

describe("ISS-8907 — the telemetry message, which is vendored today", () => {
  test("gives a packaging break its own message, distinct from the generic one", () => {
    // ISS-9253 vendors `app.boot_failure.kind` into the deny-by-default
    // collector, so the attribute carries the distinction too — but only once
    // that config is rolled (ISS-9677), and then only from installs on ISS-8907
    // or later. The MESSAGE carries it on the installs older than that, which
    // is why it is asserted on its own here.
    const packagingBreak = buildMigrationFailureTelemetryError(
      moduleResolutionError()
    ).message;
    const generic = buildMigrationFailureTelemetryError(
      new Error("SQLITE_BUSY")
    ).message;

    expect(packagingBreak).not.toBe(generic);
    expect(generic).toBe("Agent Monitor runtime failed to initialize");
  });

  test("keeps every projected message low-cardinality and leak-free", () => {
    // The ISS-4714 contract this must not regress: no specifier, no path, no
    // stack, whatever the raw error carried.
    const projected = buildMigrationFailureTelemetryError(
      moduleResolutionError()
    );
    expect(projected.message).not.toContain("electron");
    expect(projected.message).not.toContain("/app");
    expect(projected.stack).toBeUndefined();
  });
});

describe("ISS-8907 — the strict-schema boundary", () => {
  test("the tagged record survives the .strict() parse the emitter runs", () => {
    // `emitExceptionSpan` hands this exact object to `AppTelemetrySchema.parse`.
    // An undeclared key does not drop the ATTRIBUTE, it drops the WHOLE span.
    const attributes = sanitizeDesktopException({
      error: buildMigrationFailureTelemetryError(moduleResolutionError()),
      origin: AppExceptionOrigin.Main,
      bootFailureKind: AppBootFailureKind.ModuleResolution,
    });

    expect(attributes[TelemetryAttribute.AppBootFailureKind]).toBe(
      "module_resolution"
    );
    expect(AppTelemetrySchema.parse(attributes)).toEqual(attributes);
  });

  test("every key this module can emit is declared by that schema", () => {
    const declared = Object.keys(AppTelemetrySchema.shape);
    for (const key of Object.keys(SANITIZED_EXCEPTION_ATTRIBUTE_KEY_PRESENCE)) {
      expect(declared).toContain(key);
    }
  });

  test("an older producer's untagged record still parses (version skew)", () => {
    // An installed desktop that predates this attribute sends no kind. The
    // receiving contract must read that as "not classified", so the field is
    // OMITTED rather than serialized as null — a null would fail this enum.
    const attributes = sanitizeDesktopException({
      error: new Error("SQLITE_BUSY"),
      origin: AppExceptionOrigin.Main,
    });

    expect(TelemetryAttribute.AppBootFailureKind in attributes).toBe(false);
    expect(AppTelemetrySchema.parse(attributes)).toEqual(attributes);
  });

  test("the schema refuses a kind outside the closed set", () => {
    expect(
      AppTelemetrySchema.safeParse({
        [TelemetryAttribute.AppBootFailureKind]: "disk_full",
      }).success
    ).toBe(false);
  });
});

/**
 * The production wiring. Without this, deleting `bootFailureKind` from the one
 * call site in `agent-dashboard-runtime-bootstrap.ts` leaves every assertion
 * above green — they exercise the classifier and the sanitizer, neither of which
 * knows whether the boot path actually calls them.
 */
describe("ISS-8907 — the boot path emits the kind", () => {
  test("tags the app-exception event from the RAW boot error", async () => {
    const emitAppExceptionEvent = vi.fn();
    createRuntime.mockRejectedValueOnce(moduleResolutionError());

    const result = await bootstrapAgentDashboardRuntime(
      bootstrapDeps({ emitAppExceptionEvent })
    );

    expect(result).toEqual({ ok: false });
    expect(emitAppExceptionEvent).toHaveBeenCalledTimes(1);
    expect(emitAppExceptionEvent.mock.calls[0]?.[0]).toMatchObject({
      origin: AppExceptionOrigin.Main,
      bootFailureKind: AppBootFailureKind.ModuleResolution,
    });
  });

  test("tags a refusal differently on that same call site", async () => {
    // Two boots through the REAL bootstrap path, disagreeing — which is the
    // acceptance criterion, proven where it has to hold rather than on the
    // classifier in isolation.
    const emitAppExceptionEvent = vi.fn();
    createRuntime.mockRejectedValueOnce(
      new DesktopMigrationError(
        MigrationRefusalKind.Downgrade,
        "store created by 0100_future"
      )
    );

    await bootstrapAgentDashboardRuntime(
      bootstrapDeps({ emitAppExceptionEvent })
    );

    expect(emitAppExceptionEvent.mock.calls[0]?.[0]).toMatchObject({
      bootFailureKind: AppBootFailureKind.MigrationRefusal,
    });
  });
});

describe("ISS-8907 — the boot prelude is inside the failure path", () => {
  test("a throw before the runtime call still reaches the classified emit", () => {
    // Pins the try BOUNDARY, not the runtime call. `configureOrgDirectoryPersistence`
    // and the dynamic `import()` of the runtime module both used to sit ABOVE the
    // try; a throw from either left this function entirely, and `startAgentCapture`
    // answers that with a `.catch` (apps/desktop/src/main/app.ts) that writes one
    // local log line and emits NO telemetry. That is the exact invisibility ISS-8907
    // exists to close. This case drives the org-directory statement because it is a
    // plain injected dep; the dynamic import is the statement beside it in the same
    // block, so the boundary this pins is the one that covers both.
    const emitAppExceptionEvent = vi.fn();
    return bootstrapAgentDashboardRuntime(
      bootstrapDeps({
        emitAppExceptionEvent,
        configureOrgDirectoryPersistence: () =>
          Promise.reject(moduleResolutionError()),
      })
    ).then((result) => {
      expect(result).toEqual({ ok: false });
      expect(emitAppExceptionEvent).toHaveBeenCalledTimes(1);
      expect(emitAppExceptionEvent.mock.calls[0]?.[0]).toMatchObject({
        origin: AppExceptionOrigin.Main,
        bootFailureKind: AppBootFailureKind.ModuleResolution,
      });
    });
  });
});
