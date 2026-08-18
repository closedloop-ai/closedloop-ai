/**
 * ISS-5868 — the LocalElectron route reports its own field loss.
 *
 * The API's persist boundary warns about what it discards, but a LocalElectron
 * health check never touches the API: the browser talks to the gateway directly
 * and parses the response in place. The same `z.preprocess` guards drop the same
 * malformed fields there, and before this nothing said so on that route.
 *
 * These drive `parseHealthCheckResponse` through the REAL in-browser schema —
 * not the detector in isolation — because the whole defect is that the live
 * parse is the thing losing the field. Client code cannot log, so the assertion
 * is on the analytics sink, which is the client monitoring path.
 */

import { HealthCheckRepairAction } from "@repo/api/src/types/compute-target";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setClientEventSink } from "@/lib/analytics/client-event-sink";
import { healthCheckOptions } from "@/lib/engineer/queries/health-check";
import { HEALTH_CHECK_FIELDS_DROPPED_EVENT } from "@/lib/system-check/health-check-field-loss";

type CapturedEvent = [string, Record<string, unknown>];

const captured: CapturedEvent[] = [];

const repairableRow = {
  id: "plugin-code",
  label: "Symphony Plugin",
  required: true,
  passed: false,
  error: "Could not verify enabled state",
};

function installGatewayResponse(payload: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      })
    )
  );
}

async function runHealthCheck(payload: unknown) {
  installGatewayResponse(payload);
  const options = healthCheckOptions("default", null);
  const queryFn = options.queryFn;
  if (typeof queryFn !== "function") {
    throw new Error("healthCheckOptions must supply a queryFn");
  }
  return await queryFn({
    signal: new AbortController().signal,
  } as never);
}

function getDroppedEvent(): Record<string, unknown> {
  const event = captured.find(
    ([name]) => name === HEALTH_CHECK_FIELDS_DROPPED_EVENT
  );
  if (!event) {
    throw new Error(
      `No ${HEALTH_CHECK_FIELDS_DROPPED_EVENT} event was captured; got ${JSON.stringify(captured.map(([name]) => name))}`
    );
  }
  return event[1];
}

describe("in-browser health-check field loss (ISS-5868)", () => {
  beforeEach(() => {
    captured.length = 0;
    setClientEventSink((event, properties) => {
      captured.push([event, properties as Record<string, unknown>]);
    });
  });

  afterEach(() => {
    setClientEventSink(undefined);
    vi.unstubAllGlobals();
  });

  it("reports a dropped outcome while still returning the parsed panel", async () => {
    const parsed = await runHealthCheck({
      checks: [
        { ...repairableRow, enableAttempted: true, enableOutcome: null },
        { id: "git", label: "Git", required: true, passed: true },
      ],
      allRequiredPassed: false,
    });

    // The response still parses — degrading one field beats losing the panel.
    expect(parsed.checks).toHaveLength(2);
    expect(getDroppedEvent()).toMatchObject({
      checkCount: 2,
      droppedFieldCount: 1,
      droppedFieldSample: ["plugin-code.enableOutcome"],
    });
  });

  it("reports a dropped MCP repair action, which is not in checks[]", async () => {
    await runHealthCheck({
      checks: [{ id: "git", label: "Git", required: true, passed: true }],
      allRequiredPassed: true,
      mcpServers: {
        claude: {
          available: false,
          serverName: "closedloop",
          matchedUrl: null,
          checkedAt: "2026-08-14T00:00:00.000Z",
          repair: { repairable: true, action: "teleport_the_plugin" },
        },
      },
    });

    expect(getDroppedEvent()).toMatchObject({
      droppedFieldSample: ["mcpServers.claude.repair.action"],
    });
  });

  it("reports a dropped repair action on a CHECK row, which no guarded field covers", async () => {
    // `repair.action` is nested, so the guarded-field sweep cannot reach it and
    // the detector handles it by hand. Every other case here pairs a check row
    // with a VALID action, so without this the hand-written branch could be
    // deleted outright with the suite still green — and a gateway naming an
    // action this build has not heard of would lose it in silence, rendering a
    // repairable row as "Repair unsupported" with no signal. Mirrors the
    // API-side assertion in compute-targets-health-check-dropped-fields.test.ts.
    await runHealthCheck({
      checks: [
        {
          ...repairableRow,
          repair: { repairable: true, action: "teleport_the_plugin" },
        },
        {
          ...repairableRow,
          id: "plugin-enabled",
          repair: { repairable: true, action: { nested: "object" } },
        },
      ],
      allRequiredPassed: false,
    });

    expect(getDroppedEvent().droppedFieldSample).toEqual([
      "plugin-code.repair.action",
      "plugin-enabled.repair.action",
    ]);
  });

  it("names only the dropping field, never a valid sibling", async () => {
    await runHealthCheck({
      checks: [
        {
          ...repairableRow,
          updateOutcome: 7,
          repair: {
            repairable: true,
            action: HealthCheckRepairAction.EnablePlugins,
          },
        },
      ],
      allRequiredPassed: false,
    });

    expect(getDroppedEvent().droppedFieldSample).toEqual([
      "plugin-code.updateOutcome",
    ]);
  });

  it("stays silent when the gateway sent nothing unusable", async () => {
    await runHealthCheck({
      checks: [{ id: "git", label: "Git", required: true, passed: true }],
      allRequiredPassed: true,
    });

    expect(captured).toEqual([]);
  });

  it("bounds the sample and truncates an absurd check id", async () => {
    await runHealthCheck({
      checks: Array.from({ length: 9 }, (_, index) => ({
        ...repairableRow,
        id: `${"z".repeat(400)}-${index}`,
        enableOutcome: null,
      })),
      allRequiredPassed: false,
    });

    const event = getDroppedEvent();
    expect(event.droppedFieldCount).toBe(9);
    expect(event.droppedFieldSample).toHaveLength(5);
    for (const name of event.droppedFieldSample as string[]) {
      expect(name).toHaveLength(120);
    }
  });
});
