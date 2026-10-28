/**
 * @file golden-layer2-billing-mode-guard.test.ts
 * @description ISS-7839 tests for the Layer 2 billing-mode legality guard: a
 * captured `sessions.billing_mode` must be a real `BillingMode`.
 *
 * These exist because the guard never fires on the current corpus — every
 * dossier now seeds a legal value — so without them, deleting the assertion
 * would leave the whole suite green. That is precisely the "test cannot fail"
 * shape AGENTS.md rejects, so the illegal cases are exercised here directly.
 *
 * Lives beside its module rather than in `golden-layer2.ts`, which is at the
 * file-size ceiling and shrink-only.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { BILLING_MODES } from "../src/shared/billing-mode.js";
import {
  assertLegalBillingModes,
  captureRawStores,
} from "./golden/golden-layer2-store-capture.js";

/** The exact literal ISS-7839 removed: reads as metered, is not a BillingMode. */
const ILLEGAL_LEGACY_STUB = "metered_api";
/** Biome useTopLevelRegex: matchers live at module scope. */
const ILLEGAL_STUB_RE = /metered_api/;
const NOT_A_BILLING_MODE_RE = /is not a BillingMode/;
const SESSION_S3_RE = /session s3/;

test("rejects the illegal metered_api stub ISS-7839 removed", () => {
  assert.throws(
    () =>
      assertLegalBillingModes([
        { id: "s1", billing_mode: ILLEGAL_LEGACY_STUB },
      ]),
    ILLEGAL_STUB_RE
  );
});

test("rejects a null billing_mode", () => {
  assert.throws(
    () => assertLegalBillingModes([{ id: "s1", billing_mode: null }]),
    NOT_A_BILLING_MODE_RE
  );
});

test("rejects an unrecognized future value", () => {
  assert.throws(
    () => assertLegalBillingModes([{ id: "s1", billing_mode: "metered" }]),
    NOT_A_BILLING_MODE_RE
  );
});

test("accepts every member of BILLING_MODES", () => {
  for (const mode of BILLING_MODES) {
    assertLegalBillingModes([{ id: `s-${mode}`, billing_mode: mode }]);
  }
});

test("accepts an empty session-row set", () => {
  assertLegalBillingModes([]);
});

test("fails on an illegal row even when legal rows precede it", () => {
  assert.throws(
    () =>
      assertLegalBillingModes([
        { id: "s1", billing_mode: "api" },
        { id: "s2", billing_mode: "unknown" },
        { id: "s3", billing_mode: ILLEGAL_LEGACY_STUB },
      ]),
    SESSION_S3_RE
  );
});

/**
 * The guard is only worth having if the capture path actually calls it. Without
 * this, deleting the call site in `captureRawStores` leaves both these unit
 * tests and the whole golden corpus green — every dossier now seeds a legal
 * value, so nothing else would go red.
 */
test("captureRawStores invokes the guard on the rows it captures", async () => {
  const illegalStore = {
    prisma: {
      client: {
        $queryRawUnsafe: <T>(sql: string): Promise<T> =>
          Promise.resolve(
            (sql.includes("FROM sessions")
              ? [{ id: "s1", billing_mode: ILLEGAL_LEGACY_STUB }]
              : []) as T
          ),
      },
    },
  };
  await assert.rejects(() => captureRawStores(illegalStore), ILLEGAL_STUB_RE);
});

test("captureRawStores returns normally when every session row is legal", async () => {
  const legalStore = {
    prisma: {
      client: {
        $queryRawUnsafe: <T>(sql: string): Promise<T> =>
          Promise.resolve(
            (sql.includes("FROM sessions")
              ? [{ id: "s1", billing_mode: "unknown" }]
              : []) as T
          ),
      },
    },
  };
  const captured = await captureRawStores(legalStore);
  assert.equal(captured.sessions.length, 1);
});
