/**
 * ISS-5868 — a non-string where a `z.preprocess` guard expects one must cost
 * that FIELD, never the whole response.
 *
 * `healthCheckResponseSchema` is parsed as one unit, so before this fix a
 * gateway sending `enableOutcome: null` on a single row failed the entire
 * health check with "Gateway health check returned an invalid response" — the
 * panel showed nothing at all rather than one row missing one telemetry field,
 * and every retry re-dropped it.
 *
 * A sibling of `health-check.test.ts` rather than an addition to it: that file
 * is already near the 1,000-line ceiling.
 */

import { HealthCheckRepairAction } from "@repo/api/src/types/compute-target";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { GUARDED_CHECK_FIELDS } from "@/lib/system-check/health-check-field-loss";
import { healthCheckOptions, healthCheckResponseSchema } from "../health-check";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubGatewayResponse(body: unknown): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
}

function runHealthCheckQuery(
  options: ReturnType<typeof healthCheckOptions>
): Promise<unknown> {
  return makeQueryClient().fetchQuery(options);
}

const pluginRow = {
  id: "plugin-code",
  label: "Symphony Plugin",
  required: true,
  passed: false,
};

describe("health-check response non-string guards (ISS-5868)", () => {
  it.each([
    null,
    7,
    { outcome: "success" },
  ])("drops a non-string enableOutcome (%p) and keeps the rest of the response", async (enableOutcome) => {
    stubGatewayResponse({
      checks: [
        { ...pluginRow, enableAttempted: true, enableOutcome },
        { id: "git", label: "Git", required: true, passed: true },
      ],
      allRequiredPassed: false,
    });

    await expect(
      runHealthCheckQuery(healthCheckOptions("default", null))
    ).resolves.toEqual({
      checks: [
        { ...pluginRow, enableAttempted: true },
        { id: "git", label: "Git", required: true, passed: true },
      ],
      allRequiredPassed: false,
    });
  });

  it("drops a non-string repair action and keeps the row repairable", async () => {
    stubGatewayResponse({
      checks: [{ ...pluginRow, repair: { repairable: true, action: null } }],
      allRequiredPassed: false,
    });

    await expect(
      runHealthCheckQuery(healthCheckOptions("default", null))
    ).resolves.toEqual({
      checks: [{ ...pluginRow, repair: { repairable: true } }],
      allRequiredPassed: false,
    });
  });

  it("still keeps a recognised repair action", async () => {
    stubGatewayResponse({
      checks: [
        {
          ...pluginRow,
          repair: {
            repairable: true,
            action: HealthCheckRepairAction.EnablePlugins,
          },
        },
      ],
      allRequiredPassed: false,
    });

    await expect(
      runHealthCheckQuery(healthCheckOptions("default", null))
    ).resolves.toEqual({
      checks: [
        {
          ...pluginRow,
          repair: {
            repairable: true,
            action: HealthCheckRepairAction.EnablePlugins,
          },
        },
      ],
      allRequiredPassed: false,
    });
  });
});

/**
 * ISS-5868 review follow-up — the client half of the drift guard the API side
 * got in this same PR (`validators.test.ts`, "guarded-field list agrees with the
 * validator shape").
 *
 * `GUARDED_CHECK_FIELDS` is hand-maintained beside the `z.preprocess` guards in
 * `health-check.ts`. Add a guard to the schema tomorrow without adding it to the
 * list and that field goes back to being dropped in exactly the silence ISS-5868
 * exists to break, with nothing to catch the drift.
 *
 * The client list is CORRECTLY smaller than the API's — that boundary has no
 * `.passthrough()` and guards `severity` and `blockedBy` too, while this schema
 * passes unknown keys through and never declares those two, so they cannot be
 * dropped here. This pins the client list against the CLIENT schema, so the
 * legitimate divergence stays legitimate.
 *
 * Behavioural, like its API twin: a guarded field is one that answers a
 * structurally invalid value with "absent" instead of an error. No Zod
 * internals, no source scanning.
 */
describe("guarded-field list agrees with the in-browser schema (ISS-5868)", () => {
  /** Invalid for every declared field type, and not an accepted `debug` object. */
  const STRUCTURALLY_INVALID = { __notAFieldValue: true } as const;

  const checkResultShape = healthCheckResponseSchema.shape.checks.element.shape;
  const repairShape = checkResultShape.repair.unwrap().shape;

  function getDegradingKeys(shape: Record<string, z.ZodTypeAny>): string[] {
    return Object.entries(shape)
      .filter(([, schema]) => {
        const parsed = schema.safeParse(STRUCTURALLY_INVALID);
        return parsed.success && parsed.data === undefined;
      })
      .map(([key]) => key)
      .sort();
  }

  it("names every check-row field the in-browser schema degrades to absent", () => {
    expect(getDegradingKeys(checkResultShape)).toEqual(
      [...GUARDED_CHECK_FIELDS].sort()
    );
  });

  it("confirms `action` is the only degrading field on a repair object", () => {
    // The detector handles `repair.action` by hand rather than through the list
    // above, because it is nested. A second degrading field appearing here would
    // need the same treatment, so pin it.
    expect(getDegradingKeys(repairShape)).toEqual(["action"]);
  });

  it("does not mistake a passthrough object field for a guard", () => {
    // `debug` accepts the probe value rather than degrading it, which is what
    // keeps the derived set from over-reporting. Asserted directly so a future
    // change to the probe value cannot quietly widen it.
    const parsed = checkResultShape.debug.safeParse(STRUCTURALLY_INVALID);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).not.toBeUndefined();
  });
});
