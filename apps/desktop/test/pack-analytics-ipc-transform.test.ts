/**
 * @file pack-analytics-ipc-transform.test.ts
 * @description ISS-4845 — desktop-IPC-boundary regression for the ISS-4667
 * version-skew transform in `src/main/packs/pack-analytics-ipc.ts`.
 *
 * The canonical-vs-legacy resolution is already unit-tested one level down, at
 * `resolveLocPerDollar` (`packages/api/src/utils/loc-per-dollar.test.ts`). What
 * was untested is the boundary itself: the module runtime-imports Electron's
 * `ipcMain`, so its Zod wire schema and `.transform()` could not be reached from
 * `test:node` at all. The electron-module mock closes that gap, and this suite
 * drives the REAL registered IPC handler end to end — wire payload in, renderer
 * response out — so a regression in the schema, the transform, or the envelope
 * unwrap is caught where the renderer would actually feel it.
 *
 * The four pins are the ones ISS-4845 names:
 *   1. a PRESENT canonical `locDelta: null` is authoritative and is NOT
 *      overridden by a stale legacy delta from a mixed payload;
 *   2. an OMITTED canonical `locDelta` falls back to the legacy delta (a
 *      percentage lift is unit-free, so no scaling);
 *   3. a malformed nonpositive canonical LOC/$ normalizes to `null` rather than
 *      rendering a fabricated efficiency score;
 *   4. an OMITTED canonical LOC/$ scales the producer's legacy value into LOC/$.
 *
 * Case 4 builds its legacy-only payload by spreading `emitLocPerDollarWithLegacy`
 * — the canonical EMIT-side shim the cloud actually uses — and dropping the
 * canonical field. That makes it a true producer→consumer round trip (emit
 * scales down, this schema scales back up) instead of a hand-written constant,
 * and it reads the legacy wire key off the shared SSOT rather than restating it.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { emitLocPerDollarWithLegacy } from "@repo/api/src/utils/loc-per-dollar";
import { PACK_ANALYTICS_IPC_CHANNEL } from "../src/shared/pack-analytics-channel.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";
import {
  type IpcMainInvokeHandler,
  registeredInvokeHandler,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";

/** Every field `packAnalyticsSchema` requires, with no skew-sensitive metrics. */
const BASE_WIRE_PAYLOAD = {
  packId: "pack-under-test",
  invocations: 12,
  sessions: 3,
  owners: ["mike"],
  deviceCount: 2,
};

const API_ORIGIN = "https://api.example.test";
const ACCESS_TOKEN = "test-token";
/** A plausible LOC/$ figure: 4,004 lines for $3.20 of spend. */
const CANONICAL_LOC_PER_DOLLAR = 1251.25;
/** The error an untrusted renderer must get instead of pack analytics. */
const UNTRUSTED_SENDER_ERROR = /untrusted sender/;
/** A percentage lift — unit-free, so the legacy alias carries the same number. */
const LEGACY_DELTA_PERCENT = 12.5;

type PackAnalyticsResult = {
  locPerDollar: number | null;
  locDelta: number | null;
  mergedPrsTruncated?: boolean;
};

let mock: ElectronModuleMock;
let registerPackAnalyticsIpc: (deps: {
  getAccessToken: () => Promise<string | null>;
  getApiOrigin: () => string | undefined;
  isTrustedSender: (sender: never) => boolean;
}) => void;
let originalFetchDescriptor: PropertyDescriptor | undefined;

before(async () => {
  mock = registerElectronModuleMock();
  // Dynamic, because the redirect must be installed before the module under
  // test evaluates its `import { ipcMain } from "electron"`.
  const module = await import("../src/main/packs/pack-analytics-ipc.js");
  registerPackAnalyticsIpc =
    module.registerPackAnalyticsIpc as typeof registerPackAnalyticsIpc;
});

after(() => {
  mock.deregister();
});

beforeEach(() => {
  originalFetchDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "fetch"
  );
});

afterEach(() => {
  if (originalFetchDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, "fetch");
  } else {
    Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
  }
  resetElectronModuleStub();
});

/**
 * Register the handler against a wire payload the cloud would return, then
 * invoke it exactly as the renderer's `ipcRenderer.invoke` does.
 */
async function invokeWithWirePayload(
  wirePayload: Record<string, unknown>
): Promise<PackAnalyticsResult | null> {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: () =>
      Promise.resolve(
        new Response(JSON.stringify({ success: true, data: wirePayload }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      ),
  });

  registerPackAnalyticsIpc({
    getAccessToken: () => Promise.resolve(ACCESS_TOKEN),
    getApiOrigin: () => API_ORIGIN,
    isTrustedSender: () => true,
  });

  const handler: IpcMainInvokeHandler = registeredInvokeHandler(
    PACK_ANALYTICS_IPC_CHANNEL
  );
  return (await handler(
    { sender: {} },
    BASE_WIRE_PAYLOAD.packId
  )) as PackAnalyticsResult | null;
}

describe("pack-analytics IPC version-skew transform", () => {
  it("keeps a present canonical null delta instead of reviving a stale legacy delta", async () => {
    const result = await invokeWithWirePayload({
      ...BASE_WIRE_PAYLOAD,
      locDelta: null,
      klocDelta: LEGACY_DELTA_PERCENT,
    });

    assert.ok(result, "the IPC handler must return a parsed response");
    // A plain `??` would revive the stale legacy value here. `null` is the
    // producer's honest "not computable", and it is authoritative.
    assert.equal(result.locDelta, null);
  });

  it("falls back to the legacy delta when the canonical field is omitted", async () => {
    const result = await invokeWithWirePayload({
      ...BASE_WIRE_PAYLOAD,
      klocDelta: LEGACY_DELTA_PERCENT,
    });

    assert.ok(result);
    assert.equal(result.locDelta, LEGACY_DELTA_PERCENT);
  });

  it("normalizes a malformed nonpositive canonical LOC/$ to null", async () => {
    const result = await invokeWithWirePayload({
      ...BASE_WIRE_PAYLOAD,
      locPerDollar: -5,
    });

    assert.ok(
      result,
      "a malformed metric must degrade to a placeholder, not drop the whole response"
    );
    assert.equal(result.locPerDollar, null);
  });

  it("scales a legacy-only efficiency payload back into LOC/$", async () => {
    // Build the skewed payload from the canonical EMIT shim, then drop the
    // canonical field — a pre-ISS-4667 producer's exact wire shape. Reading the
    // legacy key off the SSOT keeps this test from restating a deprecated field
    // name, and makes the assertion a genuine emit→read round trip.
    const { locPerDollar: _canonical, ...legacyOnlyEfficiency } =
      emitLocPerDollarWithLegacy(CANONICAL_LOC_PER_DOLLAR);

    const result = await invokeWithWirePayload({
      ...BASE_WIRE_PAYLOAD,
      ...legacyOnlyEfficiency,
    });

    assert.ok(result);
    assert.ok(result.locPerDollar !== null);
    // Round-tripping through the ÷1000 legacy unit is float division, so compare
    // within a tolerance far tighter than the 1000x error this guards against.
    assert.ok(
      Math.abs(result.locPerDollar - CANONICAL_LOC_PER_DOLLAR) < 1e-6,
      `expected ~${CANONICAL_LOC_PER_DOLLAR} LOC/$, got ${result.locPerDollar}`
    );
  });

  /**
   * ISS-6462: the schema declared `mergedPrs` but not the flag saying that count
   * covered only the first `COHORT_SCAN_CAP` cohort sessions, so Zod stripped
   * the disclosure at this boundary and the overlay's Performance tile printed a
   * capped scan as an exact count. These two are the whole reason the field is
   * `.optional()` and NOT `.default(false)`.
   */
  it("carries the merged-PR truncation flag across the IPC boundary", async () => {
    const result = await invokeWithWirePayload({
      ...BASE_WIRE_PAYLOAD,
      mergedPrs: 996,
      mergedPrsTruncated: true,
    });

    assert.ok(result);
    assert.equal(result.mergedPrsTruncated, true);
  });

  it("keeps a declared whole-cohort truncation flag as false, not as undeclared", async () => {
    // The `?? undefined` fold that turns `null` into an omission must not also
    // swallow `false`. `false` is the producer DECLARING it covered the whole
    // cohort, and folding it to `undefined` would print the undeclared-coverage
    // caveat over a response that answered the question — the same overstatement
    // as the cap, pointed the other way. A `||` in that fold passes every other
    // case in this file, so this is the pin that catches it.
    const result = await invokeWithWirePayload({
      ...BASE_WIRE_PAYLOAD,
      mergedPrs: 996,
      mergedPrsTruncated: false,
    });

    assert.ok(result);
    assert.equal(result.mergedPrsTruncated, false);
  });

  it("leaves an omitted truncation flag absent rather than defaulting it to false", async () => {
    const result = await invokeWithWirePayload({
      ...BASE_WIRE_PAYLOAD,
      mergedPrs: 996,
    });

    assert.ok(result);
    // A cloud predating the disclosure applies the same cap and cannot report
    // it. `false` here would make the renderer assert full-cohort coverage
    // precisely when it does not hold, which is the defect pointed the other
    // way — so the omission must survive as an omission.
    assert.equal(result.mergedPrsTruncated, undefined);
  });

  it("reads an explicitly null truncation flag as undeclared, not as a parse failure", async () => {
    // Every sibling metric here tolerates `null`. A producer that serializes
    // this absent optional as `null` must not fail the WHOLE parse — that drops
    // the response to the null sentinel and blanks the entire overlay over one
    // advisory field.
    const result = await invokeWithWirePayload({
      ...BASE_WIRE_PAYLOAD,
      mergedPrs: 996,
      mergedPrsTruncated: null,
    });

    assert.ok(result, "a null advisory field must not blank the overlay");
    assert.equal(result.mergedPrsTruncated, undefined);
  });

  /**
   * ISS-6462 (wongk, #5096 review): `null` was only the FIRST unusable spelling.
   * A string, a number, or a future tri-state value all mean the same thing —
   * this response does not declare its coverage — and none of them is worth
   * blanking eleven real metrics over. The web path already reads anything other
   * than `true`/`false` as unknown (`resolveMergedPrsCoverage`), so `.catch`
   * makes this boundary degrade the same way instead of dropping the response.
   */
  for (const [label, unusable] of [
    ["a string", "true"],
    ["a number", 1],
    ["a future tri-state spelling", "capped"],
  ] as const) {
    it(`degrades ${label} truncation flag to undeclared without dropping the response`, async () => {
      const result = await invokeWithWirePayload({
        ...BASE_WIRE_PAYLOAD,
        locPerDollar: CANONICAL_LOC_PER_DOLLAR,
        mergedPrs: 996,
        mergedPrsTruncated: unusable,
      });

      assert.ok(
        result,
        "an unusable advisory field must not blank the overlay"
      );
      assert.equal(result.mergedPrsTruncated, undefined);
      // The rest of the payload survives intact — the point of catching rather
      // than failing is that the other metrics still reach the tile.
      assert.equal(result.locPerDollar, CANONICAL_LOC_PER_DOLLAR);
    });
  }

  it("returns the null sentinel for an untrusted sender's request", async () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: () => Promise.reject(new Error("fetch must not be reached")),
    });
    registerPackAnalyticsIpc({
      getAccessToken: () => Promise.resolve(ACCESS_TOKEN),
      getApiOrigin: () => API_ORIGIN,
      isTrustedSender: () => false,
    });

    await assert.rejects(
      async () =>
        await registeredInvokeHandler(PACK_ANALYTICS_IPC_CHANNEL)(
          { sender: {} },
          BASE_WIRE_PAYLOAD.packId
        ),
      UNTRUSTED_SENDER_ERROR
    );
  });
});
