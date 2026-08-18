import { CheckSeverity } from "@closedloop-ai/loops-api/compute-target";
import {
  HealthCheckRepairAction,
  PluginUpdateOutcome,
} from "@repo/api/src/types/compute-target";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { GUARDED_CHECK_FIELDS } from "./health-check-dropped-fields";
import {
  createDesktopCommandValidator,
  healthCheckRepairShape,
  healthCheckResultShape,
  healthCheckResultValidator,
  healthCheckSnapshotValidator,
} from "./validators";

const validCommand = {
  operationId: "op-1",
  method: "POST",
  path: "/api/gateway/symphony/chat/run-1",
  streaming: false,
  commandId: "0196b1bb-7a00-7000-8000-000000000010",
  signature: "YWJj",
  signaturePayload: "payload",
};

describe("createDesktopCommandValidator", () => {
  it("accepts command public-key fingerprints with the generated 22 character suffix", () => {
    expect(
      createDesktopCommandValidator.safeParse({
        ...validCommand,
        publicKeyFingerprint: "cl:abcdefghijklmnopqrstuv",
      }).success
    ).toBe(true);
  });

  it("rejects shorter command public-key fingerprints", () => {
    const parsed = createDesktopCommandValidator.safeParse({
      ...validCommand,
      publicKeyFingerprint: "cl:abcdefghijklmnop",
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts paths starting with /api/gateway/", () => {
    expect(
      createDesktopCommandValidator.safeParse({
        operationId: "op-1",
        method: "POST",
        path: "/api/gateway/symphony/chat/run-1",
        streaming: false,
      }).success
    ).toBe(true);
  });

  it("rejects legacy /api/engineer/* paths that are no longer in the gateway namespace", () => {
    const parsed = createDesktopCommandValidator.safeParse({
      operationId: "op-1",
      method: "GET",
      path: "/api/engineer/health-check",
      streaming: false,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((issue) =>
          issue.message.includes("/api/gateway/")
        )
      ).toBe(true);
    }
  });
});

describe("healthCheckResultValidator", () => {
  it("preserves plugin enable repair fields", () => {
    const parsed = healthCheckResultValidator.parse({
      id: "plugin-code",
      label: "Symphony Plugin",
      required: true,
      passed: true,
      enableAttempted: true,
      enableOutcome: PluginUpdateOutcome.Success,
      enablePluginIds: ["code@closedloop-ai"],
    });

    expect(parsed.enableAttempted).toBe(true);
    expect(parsed.enableOutcome).toBe("success");
    expect(parsed.enablePluginIds).toEqual(["code@closedloop-ai"]);
  });

  it("omits unknown additive plugin repair outcome telemetry", () => {
    const parsed = healthCheckResultValidator.parse({
      id: "plugin-code",
      label: "Symphony Plugin",
      required: true,
      passed: false,
      enableAttempted: true,
      enableOutcome: "not_attempted",
      updateAttempted: true,
      updateOutcome: "queued",
    });

    expect(parsed.enableAttempted).toBe(true);
    expect(parsed.enableOutcome).toBeUndefined();
    expect(parsed.updateAttempted).toBe(true);
    expect(parsed.updateOutcome).toBeUndefined();
  });
});

/**
 * ISS-5868. PR #4772 taught `severity` and `blockedBy` to degrade an unusable
 * value to "absent"; the plugin-outcome and repair-action guards still only
 * rewrote an unrecognised STRING, so a NON-string handed the raw value to the
 * enum and failed it. Rejection here is not field- or row-scoped —
 * `healthCheckSnapshotValidator` fails the whole PUT — so one unusable field
 * discarded the entire refresh and left the STALE snapshot in place, re-dropped
 * on every retry.
 */
describe("healthCheckResultValidator non-string enum guards (ISS-5868)", () => {
  const baseRow = {
    id: "plugin-code",
    label: "Symphony Plugin",
    required: true,
    passed: false,
    error: "Could not verify enabled state",
  };

  it.each([
    null,
    7,
    { outcome: "success" },
    ["success"],
    true,
  ])("drops a non-string enableOutcome (%p) instead of failing the row", (enableOutcome) => {
    const parsed = healthCheckResultValidator.safeParse({
      ...baseRow,
      enableAttempted: true,
      enableOutcome,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.enableOutcome).toBeUndefined();
    // The rest of the row has to survive the drop, or nothing was gained.
    expect(parsed.success && parsed.data.enableAttempted).toBe(true);
    expect(parsed.success && parsed.data.error).toBe(
      "Could not verify enabled state"
    );
  });

  it.each([
    null,
    7,
    { outcome: "success" },
  ])("drops a non-string updateOutcome (%p) instead of failing the row", (updateOutcome) => {
    const parsed = healthCheckResultValidator.safeParse({
      ...baseRow,
      updateAttempted: true,
      updateOutcome,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.updateOutcome).toBeUndefined();
    expect(parsed.success && parsed.data.updateAttempted).toBe(true);
  });

  it.each([
    null,
    7,
    { action: "enable_plugins" },
  ])("drops a non-string repair action (%p) instead of failing the row", (action) => {
    const parsed = healthCheckResultValidator.safeParse({
      ...baseRow,
      repair: {
        repairable: true,
        action,
        reason: "Run it on that machine.",
      },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.repair).toEqual({
      repairable: true,
      reason: "Run it on that machine.",
    });
  });

  it("keeps every sibling row when one carries a non-string outcome", () => {
    const parsed = healthCheckSnapshotValidator.safeParse({
      result: {
        checks: [
          { ...baseRow, enableOutcome: null },
          { id: "git", label: "Git", required: true, passed: true },
        ],
        allRequiredPassed: false,
      },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.result.checks).toHaveLength(2);
    expect(parsed.success && parsed.data.result.checks[1].id).toBe("git");
  });

  it("still keeps a recognised outcome and action", () => {
    const parsed = healthCheckResultValidator.safeParse({
      ...baseRow,
      enableOutcome: PluginUpdateOutcome.Success,
      repair: {
        repairable: true,
        action: HealthCheckRepairAction.EnablePlugins,
      },
    });

    expect(parsed.success && parsed.data.enableOutcome).toBe(
      PluginUpdateOutcome.Success
    );
    expect(parsed.success && parsed.data.repair?.action).toBe(
      HealthCheckRepairAction.EnablePlugins
    );
  });

  /**
   * Cross-repo skew: an older gateway simply omits these. An absent optional
   * must stay ABSENT after parsing rather than becoming an explicit `null` on
   * the JSON that gets stored, which is what the desktop reader would then have
   * to defend against.
   */
  it("omits absent optionals rather than serializing them as null", () => {
    const parsed = healthCheckResultValidator.safeParse(baseRow);

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    const serialized = JSON.parse(JSON.stringify(parsed.data)) as Record<
      string,
      unknown
    >;
    for (const key of [
      "enableOutcome",
      "updateOutcome",
      "repair",
      "severity",
      "blockedBy",
    ]) {
      expect(Object.hasOwn(serialized, key)).toBe(false);
    }
  });
});

describe("healthCheckResultValidator repairability (ISS-5389)", () => {
  const baseCheck = {
    id: "claude-cli",
    label: "Claude CLI",
    required: true,
    passed: false,
  };

  it("preserves the repair annotation through the persist boundary", () => {
    // The validator has no .passthrough(), so an omitted key would be silently
    // stripped before the snapshot is stored — and the pre-loop provider
    // hydrates from that snapshot.
    const parsed = healthCheckResultValidator.safeParse({
      ...baseCheck,
      repair: {
        repairable: true,
        action: HealthCheckRepairAction.ClearBinaryOverride,
        blockedByCheckId: "claude-cli",
      },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.repair).toEqual({
      repairable: true,
      action: HealthCheckRepairAction.ClearBinaryOverride,
      blockedByCheckId: "claude-cli",
    });
  });

  it("keeps the reason a not-repairable row carries", () => {
    const parsed = healthCheckResultValidator.safeParse({
      ...baseCheck,
      id: "app-version",
      repair: { repairable: false, reason: "Update it on that machine." },
    });

    expect(parsed.success && parsed.data.repair?.reason).toBe(
      "Update it on that machine."
    );
  });

  it("drops an action from a newer gateway without rejecting the row", () => {
    const parsed = healthCheckResultValidator.safeParse({
      ...baseCheck,
      repair: { repairable: true, action: "reboot_the_universe" },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.repair).toEqual({ repairable: true });
  });

  it("still parses a row from a gateway that predates Repair", () => {
    const parsed = healthCheckResultValidator.safeParse(baseCheck);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.repair).toBeUndefined();
  });
});

describe("healthCheckResultValidator severity (ISS-5369 / ISS-5811)", () => {
  const undeterminablePluginRow = {
    id: "plugin-code",
    label: "Symphony Plugin",
    required: true,
    passed: false,
    version: "1.14.7",
    error: "Could not verify enabled state",
  };

  /**
   * ISS-5369 taught the gateway to mark an undeterminable row and ISS-5811
   * found that this validator — the PERSIST boundary — had never been taught
   * the field, so it was stripped on the way into storage while the live
   * in-browser schema (which does `.passthrough()`) kept it. The pre-loop gate
   * hydrates from the stored snapshot, so on that path the signal was simply
   * gone and an undeterminable row read as a proven failure.
   */
  it("preserves severity and blockedBy through the persist boundary", () => {
    const parsed = healthCheckResultValidator.safeParse({
      ...undeterminablePluginRow,
      severity: CheckSeverity.Blocked,
      blockedBy: "claude-cli",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.severity).toBe(CheckSeverity.Blocked);
    expect(parsed.success && parsed.data.blockedBy).toBe("claude-cli");
  });

  it("preserves the unknown tier a plugin row with no single blocker carries", () => {
    const parsed = healthCheckResultValidator.safeParse({
      ...undeterminablePluginRow,
      severity: CheckSeverity.Unknown,
    });

    expect(parsed.success && parsed.data.severity).toBe(CheckSeverity.Unknown);
  });

  it("drops a severity tier from a newer gateway without rejecting the row", () => {
    const parsed = healthCheckResultValidator.safeParse({
      ...undeterminablePluginRow,
      severity: "catastrophic",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.severity).toBeUndefined();
  });

  /**
   * Rejection here is not row-scoped: `healthCheckSnapshotValidator` fails the
   * whole PUT, so one unusable field would discard every other row's `repair`,
   * `remediation` and `passed` too. A non-string severity has to degrade to
   * absent for the same reason an unrecognised tier does.
   */
  it.each([
    null,
    7,
    { tier: "unknown" },
  ])("drops a non-string severity (%p) instead of failing the row", (severity) => {
    const parsed = healthCheckResultValidator.safeParse({
      ...undeterminablePluginRow,
      severity,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.severity).toBeUndefined();
  });

  /**
   * `blockedBy` is a pointer used to label one row, and it is guarded like
   * `severity` for the same non-row-scoped reason: a gateway sending `null` — or
   * the blank string an unset field trims to — would 400 the whole snapshot PUT
   * and leave the STALE snapshot in place, discarding every valid row in the
   * refresh. Losing the label costs a label; rejecting costs the refresh.
   */
  it.each([
    null,
    "",
    "   ",
    7,
  ])("drops an unusable blockedBy (%p) instead of failing the row", (blockedBy) => {
    const parsed = healthCheckResultValidator.safeParse({
      ...undeterminablePluginRow,
      severity: CheckSeverity.Blocked,
      blockedBy,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.blockedBy).toBeUndefined();
    expect(parsed.success && parsed.data.severity).toBe(CheckSeverity.Blocked);
  });

  it("trims a padded blockedBy rather than storing the padding", () => {
    const parsed = healthCheckResultValidator.safeParse({
      ...undeterminablePluginRow,
      severity: CheckSeverity.Blocked,
      blockedBy: "  claude-cli  ",
    });

    expect(parsed.success && parsed.data.blockedBy).toBe("claude-cli");
  });

  /**
   * The whole point of degrading rather than rejecting: the OTHER rows in the
   * same payload must survive a single unusable field.
   */
  it("keeps every sibling row when one carries an unusable blockedBy", () => {
    const parsed = healthCheckSnapshotValidator.safeParse({
      result: {
        checks: [
          { ...undeterminablePluginRow, blockedBy: null },
          { id: "git", label: "Git", required: true, passed: true },
        ],
        allRequiredPassed: false,
      },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.result.checks).toHaveLength(2);
    expect(parsed.success && parsed.data.result.checks[1].id).toBe("git");
  });

  it("still parses a row from a gateway that predates severity", () => {
    const parsed = healthCheckResultValidator.safeParse(
      undeterminablePluginRow
    );

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.severity).toBeUndefined();
    expect(parsed.success && parsed.data.blockedBy).toBeUndefined();
  });

  it("carries severity through a whole snapshot, not just a bare row", () => {
    const parsed = healthCheckSnapshotValidator.safeParse({
      result: {
        checks: [
          { ...undeterminablePluginRow, severity: CheckSeverity.Unknown },
        ],
        allRequiredPassed: false,
      },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.result.checks[0].severity).toBe(
      CheckSeverity.Unknown
    );
  });
});

describe("healthCheckSnapshotValidator — MCP repair (ISS-5435)", () => {
  const baseSnapshot = {
    result: {
      checks: [],
      allRequiredPassed: false,
    },
  };

  function parseWithClaudeMcp(claude: Record<string, unknown>) {
    return healthCheckSnapshotValidator.safeParse({
      ...baseSnapshot,
      result: { ...baseSnapshot.result, mcpServers: { claude } },
    });
  }

  const neutralUnconfigured = {
    available: false,
    serverName: null,
    matchedUrl: null,
    checkedAt: "2026-04-12T00:00:00.000Z",
  };

  it("preserves the MCP repair annotation through the persist boundary", () => {
    // MCP rows are synthesized client-side from this entry, so if `repair` is
    // dropped here the row reads as un-repairable on every hydrated render.
    const parsed = parseWithClaudeMcp({
      ...neutralUnconfigured,
      repair: {
        repairable: true,
        action: HealthCheckRepairAction.ConfigureMcp,
      },
    });

    expect(parsed.success).toBe(true);
    expect(
      parsed.success && parsed.data.result.mcpServers?.claude
    ).toMatchObject({
      repair: {
        repairable: true,
        action: HealthCheckRepairAction.ConfigureMcp,
      },
    });
  });

  it("keeps the reason a not-repairable MCP row carries", () => {
    const parsed = parseWithClaudeMcp({
      ...neutralUnconfigured,
      serverName: "closedloop",
      repair: { repairable: false, reason: "Needs a sign-in on that machine." },
    });

    expect(parsed.success).toBe(true);
    expect(
      parsed.success && parsed.data.result.mcpServers?.claude
    ).toMatchObject({
      repair: { repairable: false, reason: "Needs a sign-in on that machine." },
    });
  });

  it("drops an MCP repair action from a newer gateway without rejecting the entry", () => {
    // `.passthrough()` alone would have carried the unknown action into storage
    // unvalidated; the explicit field is what applies the preprocessor.
    const parsed = parseWithClaudeMcp({
      ...neutralUnconfigured,
      repair: { repairable: true, action: "reboot_the_universe" },
    });

    expect(parsed.success).toBe(true);
    expect(
      parsed.success && parsed.data.result.mcpServers?.claude
    ).toMatchObject({ repair: { repairable: true } });
    expect(
      parsed.success &&
        (
          parsed.data.result.mcpServers?.claude as {
            repair?: { action?: string };
          }
        ).repair?.action
    ).toBeUndefined();
  });

  it("preserves the repair annotation on the LEGACY provider shape too", () => {
    const parsed = parseWithClaudeMcp({
      closedloopAvailable: false,
      checkedAt: "2026-04-12T00:00:00.000Z",
      repair: {
        repairable: true,
        action: HealthCheckRepairAction.ConfigureMcp,
      },
    });

    expect(parsed.success).toBe(true);
    expect(
      parsed.success && parsed.data.result.mcpServers?.claude
    ).toMatchObject({
      repair: {
        repairable: true,
        action: HealthCheckRepairAction.ConfigureMcp,
      },
    });
  });

  it("still parses an MCP entry from a gateway that predates MCP repair", () => {
    const parsed = parseWithClaudeMcp(neutralUnconfigured);

    expect(parsed.success).toBe(true);
    expect(
      parsed.success &&
        (
          parsed.data.result.mcpServers?.claude as {
            repair?: unknown;
          }
        ).repair
    ).toBeUndefined();
  });
});

/**
 * ISS-5868 review follow-up — `GUARDED_CHECK_FIELDS` is hand-maintained beside
 * the preprocess guards it mirrors, so a sixth guard added to the validator
 * tomorrow would leave that list silently short and the new field would be
 * dropped in the same silence ISS-5811 sat in for days.
 *
 * Deriving the list at runtime would mean reading Zod's `_zod` internals, which
 * is version-fragile and would ship that fragility into production. This checks
 * it instead — the alternative the review offered — and checks it BEHAVIOURALLY:
 * a guarded field is one that answers a structurally invalid value with
 * "absent" instead of an error, which is the exact property the reporting exists
 * to cover. No Zod internals, no source text scanning, and it fails the moment a
 * guard is added or removed on either side.
 */
describe("guarded-field list agrees with the validator shape (ISS-5868)", () => {
  /** Invalid for every declared field type, and not an accepted `debug` object. */
  const STRUCTURALLY_INVALID = { __notAFieldValue: true } as const;

  function getDegradingKeys(shape: Record<string, z.ZodTypeAny>): string[] {
    return Object.entries(shape)
      .filter(([, schema]) => {
        const parsed = schema.safeParse(STRUCTURALLY_INVALID);
        return parsed.success && parsed.data === undefined;
      })
      .map(([key]) => key)
      .sort();
  }

  it("names every check-row field that degrades an unusable value to absent", () => {
    expect(getDegradingKeys(healthCheckResultShape)).toEqual(
      [...GUARDED_CHECK_FIELDS].sort()
    );
  });

  it("confirms `action` is the only degrading field on a repair object", () => {
    // The sweep handles `repair.action` by hand rather than through the list
    // above, because it is nested. A second degrading field appearing here would
    // need the same treatment, so pin it.
    expect(getDegradingKeys(healthCheckRepairShape)).toEqual(["action"]);
  });

  it("does not mistake a passthrough object field for a guard", () => {
    // `debug` accepts the probe value rather than degrading it, which is what
    // keeps this check from over-reporting. Asserted directly so a future change
    // to the probe value cannot quietly widen the derived set.
    const parsed = healthCheckResultShape.debug.safeParse(STRUCTURALLY_INVALID);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).not.toBeUndefined();
  });
});
