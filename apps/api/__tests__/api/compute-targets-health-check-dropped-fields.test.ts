/**
 * ISS-5868 — a field the persist boundary DISCARDS must not vanish in silence.
 *
 * The four `z.preprocess` guards on a check row degrade an unusable value to
 * "absent" rather than failing the whole snapshot PUT. That is the right
 * failure mode (rejection is not row-scoped, so one bad field would throw away
 * the entire refresh) but a value coerced away with nothing said about it is a
 * corrupt producer nobody is told about — which is exactly how ISS-5811 stayed
 * invisible for days while `severity` was stripped on all 13 rows.
 *
 * A `z.preprocess` swallows the bad value before `safeParse` can raise an
 * issue, so the parse error path never sees it either. These drive the real PUT
 * route and assert on the observable signal.
 */

import { HealthCheckRepairAction } from "@repo/api/src/types/compute-target";
import { CheckSeverity } from "@closedloop-ai/loops-api/compute-target";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HEALTH_CHECK_SNAPSHOT_MAX_BYTES } from "@/app/compute-targets/validators";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createTestAuthContext,
} from "../utils/auth-helpers";

const mockWarn = vi.fn();
const mockUpsertHealthCheckSnapshot = vi.fn();

let mockAuthContext: AuthContext;

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => mockWarn(...args),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("@repo/observability/error", () => ({
  parseError: (error: unknown) => String(error),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    // biome-ignore lint/suspicious/noExplicitAny: test double for the auth wrapper
    (handler: any) => (request: any, context: any) =>
      handler(mockAuthContext, request, context?.params),
}));

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    upsertHealthCheckSnapshot: (...args: unknown[]) =>
      mockUpsertHealthCheckSnapshot(...args),
  },
}));

import { PUT } from "@/app/compute-targets/[id]/health-check/route";

const undeterminablePluginRow = {
  id: "plugin-code",
  label: "Symphony Plugin",
  required: true,
  passed: false,
  error: "Could not verify enabled state",
};

function putSnapshot(
  checks: Record<string, unknown>[],
  mcpServers?: Record<string, unknown>
) {
  const request = createMockRequest({
    method: "PUT",
    url: "http://localhost:3002/compute-targets/target-1/health-check",
    body: { result: { checks, allRequiredPassed: false, mcpServers } },
  });
  return PUT(request, {
    params: Promise.resolve({ id: "target-1" }),
  } as never);
}

function buildMcpProvider(
  action: unknown,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    available: true,
    serverName: "closedloop",
    matchedUrl: "https://mcp.example.com",
    checkedAt: "2026-08-14T00:00:00.000Z",
    repair: { repairable: true, action },
    ...overrides,
  };
}

type DroppedFieldsEvent = {
  droppedFieldCount: number;
  checkCount: number;
  droppedFieldSample: string[];
  computeTargetId: string;
  organizationId: string;
};

function getWarnCall(): [string, DroppedFieldsEvent] {
  // Checked rather than indexed blind: when the sweep misses a drop entirely,
  // `calls[0]` is undefined and the failure reads as a TypeError instead of
  // "nothing was reported", which is the actual defect.
  const call = mockWarn.mock.calls[0];
  if (mockWarn.mock.calls.length !== 1 || !call) {
    throw new Error(
      `Expected exactly one dropped-field warning, got ${mockWarn.mock.calls.length}`
    );
  }
  return call as [string, DroppedFieldsEvent];
}

function getWarnPayload(): DroppedFieldsEvent {
  return getWarnCall()[1];
}

/**
 * The sample is bounded and each name truncated, so assertions read it as a set
 * of the names that fit rather than the full dropped list.
 */
function getWarnSample(): string[] {
  return [...getWarnPayload().droppedFieldSample].sort();
}

describe("PUT /compute-targets/:id/health-check dropped-field reporting (ISS-5868)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    mockUpsertHealthCheckSnapshot.mockResolvedValue({ id: "snapshot-1" });
  });

  it("reports every guarded field the boundary discarded, naming the row", async () => {
    const response = await putSnapshot([
      {
        ...undeterminablePluginRow,
        enableOutcome: null,
        updateOutcome: 7,
        severity: "catastrophic",
        blockedBy: "   ",
        repair: { repairable: true, action: { nested: "object" } },
      },
      { id: "git", label: "Git", required: true, passed: true },
    ]);

    // The payload still persists — degrading is the point.
    expect(response.status).toBe(200);
    expect(mockUpsertHealthCheckSnapshot).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(getWarnPayload().droppedFieldCount).toBe(5);
    expect(getWarnSample()).toEqual([
      "plugin-code.blockedBy",
      "plugin-code.enableOutcome",
      "plugin-code.repair.action",
      "plugin-code.severity",
      "plugin-code.updateOutcome",
    ]);
  });

  it("stays silent when nothing was dropped", async () => {
    const response = await putSnapshot([
      { ...undeterminablePluginRow, severity: CheckSeverity.Unknown },
      { id: "git", label: "Git", required: true, passed: true },
    ]);

    expect(response.status).toBe(200);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("stays silent when the gateway simply omitted the optional fields", async () => {
    await putSnapshot([undeterminablePluginRow]);

    expect(mockWarn).not.toHaveBeenCalled();
  });
});

/**
 * ISS-5868 — the report is an ALERT, raised where it is trustworthy.
 *
 * Three things a plain `log.warn(...)` at the top of the handler got wrong.
 * It carried prose no monitor queries, so it would vanish into the same void
 * ISS-5811 sat in. It fired before the service proved the caller could reach the
 * target, so anyone authenticated could push content into the monitored stream
 * for a target id they have no access to. And it emitted the whole dropped list,
 * every part of which is caller-controlled — the check `id` is only `min(1)` —
 * making one PUT the author of a monitored event's cardinality.
 */
describe("PUT /compute-targets/:id/health-check dropped-field alerting (ISS-5868)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    mockUpsertHealthCheckSnapshot.mockResolvedValue({ id: "snapshot-1" });
  });

  const droppingRow = { ...undeterminablePluginRow, severity: "catastrophic" };

  it("emits a stable monitored event name, not prose", async () => {
    await putSnapshot([droppingRow]);

    expect(getWarnCall()[0]).toBe("compute_target_health_check_fields_dropped");
  });

  it("stays silent when the caller cannot reach the target", async () => {
    // The service returns null for a target the caller has no access to; the
    // route 404s. Nothing caller-controlled may reach the monitor on that path.
    mockUpsertHealthCheckSnapshot.mockResolvedValue(null);

    const response = await putSnapshot([droppingRow]);

    expect(response.status).toBe(404);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("bounds the sample and reports the true count", async () => {
    const manyDroppingRows = Array.from({ length: 12 }, (_, index) => ({
      ...undeterminablePluginRow,
      id: `plugin-${index}`,
      severity: "catastrophic",
    }));

    await putSnapshot(manyDroppingRows);

    const payload = getWarnPayload();
    expect(payload.droppedFieldCount).toBe(12);
    expect(payload.checkCount).toBe(12);
    expect(payload.droppedFieldSample).toHaveLength(5);
  });

  it("truncates a name an absurd check id would otherwise blow up", async () => {
    await putSnapshot([
      {
        ...undeterminablePluginRow,
        id: "z".repeat(4000),
        severity: "catastrophic",
      },
    ]);

    const [sampled] = getWarnPayload().droppedFieldSample;
    expect(sampled).toHaveLength(120);
  });
});

/**
 * ISS-5868 — one capped read, not two uncapped ones.
 *
 * Reporting a dropped field needs the payload as it arrived, but the route used
 * to get that by cloning the request and parsing it a SECOND time, with no byte
 * limit on either pass — so an authenticated caller could spend double the
 * server memory on one oversized snapshot. `parseBody` now hands back the same
 * pre-validation object it already parsed, under a cap.
 */
describe("PUT /compute-targets/:id/health-check body cap (ISS-5868)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    mockUpsertHealthCheckSnapshot.mockResolvedValue({ id: "snapshot-1" });
  });

  /** One check row whose `error` string alone pushes the body past the cap. */
  function buildOversizedChecks(): Record<string, unknown>[] {
    return [
      {
        id: "plugin-code",
        label: "Symphony Plugin",
        required: true,
        passed: false,
        error: "x".repeat(HEALTH_CHECK_SNAPSHOT_MAX_BYTES + 1),
      },
    ];
  }

  it("rejects an oversized snapshot with 413 and never reaches the service", async () => {
    const response = await putSnapshot(buildOversizedChecks());

    expect(response.status).toBe(413);
    expect(mockUpsertHealthCheckSnapshot).not.toHaveBeenCalled();
  });

  it("reports a drop without ever cloning the request", async () => {
    // The raw object the report is diffed against must come from the SAME read
    // `parseBody` already did. A clone is the shape of the second uncapped read
    // this replaced, so its absence is the load-bearing assertion here — and the
    // drop still being reported proves the single read fed the diff.
    const request = createMockRequest({
      method: "PUT",
      url: "http://localhost:3002/compute-targets/target-1/health-check",
      body: {
        result: {
          checks: [{ ...undeterminablePluginRow, severity: "catastrophic" }],
          allRequiredPassed: false,
        },
      },
    });
    const cloneSpy = vi.spyOn(request, "clone");

    const response = await PUT(request, {
      params: Promise.resolve({ id: "target-1" }),
    } as never);

    expect(response.status).toBe(200);
    expect(cloneSpy).not.toHaveBeenCalled();
    expect(getWarnSample()).toEqual(["plugin-code.severity"]);
  });

  it("still accepts a large but plausible snapshot", async () => {
    const response = await putSnapshot([
      {
        id: "plugin-code",
        label: "Symphony Plugin",
        required: true,
        passed: false,
        error: "x".repeat(60_000),
      },
    ]);

    expect(response.status).toBe(200);
    expect(mockUpsertHealthCheckSnapshot).toHaveBeenCalledTimes(1);
  });
});

/**
 * ISS-5868 — the MCP provider entries run the SAME dropping guard as the check
 * rows, and they are not in `result.checks`, so the index-aligned sweep over
 * `checks[]` never reaches them.
 *
 * `repair.action` is the only place a gateway can state that Repair is drivable
 * on a `<provider>-mcp` row the web synthesizes from this entry (ISS-5435), so a
 * dropped action renders a repairable MCP row as "Repair unsupported" — the
 * exact silent-loss shape this reporting exists to break.
 */
describe("PUT /compute-targets/:id/health-check mcpServers repair drops (ISS-5868)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    mockUpsertHealthCheckSnapshot.mockResolvedValue({ id: "snapshot-1" });
  });

  const passingChecks = [
    { id: "git", label: "Git", required: true, passed: true },
  ];

  it("reports a dropped repair action on each MCP provider", async () => {
    const response = await putSnapshot(passingChecks, {
      claude: buildMcpProvider("teleport_the_plugin"),
      codex: buildMcpProvider({ nested: "object" }),
    });

    expect(response.status).toBe(200);
    expect(mockUpsertHealthCheckSnapshot).toHaveBeenCalledTimes(1);
    expect(getWarnSample()).toEqual([
      "mcpServers.claude.repair.action",
      "mcpServers.codex.repair.action",
    ]);
  });

  it("reports the dropping provider only, leaving a valid sibling out", async () => {
    await putSnapshot(passingChecks, {
      claude: buildMcpProvider(HealthCheckRepairAction.EnablePlugins),
      codex: buildMcpProvider(null),
    });

    expect(getWarnSample()).toEqual(["mcpServers.codex.repair.action"]);
  });

  it("reports a drop on the legacy provider shape too", async () => {
    await putSnapshot(passingChecks, {
      claude: {
        closedloopAvailable: true,
        checkedAt: "2026-08-14T00:00:00.000Z",
        repair: { repairable: true, action: 7 },
      },
    });

    expect(getWarnSample()).toEqual(["mcpServers.claude.repair.action"]);
  });

  it("stays silent when every MCP repair action is one this build knows", async () => {
    const response = await putSnapshot(passingChecks, {
      claude: buildMcpProvider(HealthCheckRepairAction.EnablePlugins),
      codex: buildMcpProvider(HealthCheckRepairAction.EnablePlugins),
    });

    expect(response.status).toBe(200);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("stays silent when the gateway sent no repair on its MCP entries", async () => {
    await putSnapshot(passingChecks, {
      claude: buildMcpProvider(undefined, { repair: undefined }),
    });

    expect(mockWarn).not.toHaveBeenCalled();
  });
});
