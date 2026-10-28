import type { JsonValue } from "@repo/api/src/types/common";
import {
  GITHUB_RESYNC_NUDGE_OPERATION_ID,
  GITHUB_RESYNC_NUDGE_PATH,
} from "@repo/api/src/types/github-dirty-scope";
import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_IN_FLIGHT_COMMANDS_CEILING } from "@/lib/desktop-gateway-types";
import {
  parseHelloPayload,
  resolveOperationId,
  toWireCommandFromRelayOperation,
  toWireCommandFromStore,
} from "@/lib/desktop-gateway-wire";

describe("parseHelloPayload", () => {
  const legacyHello = {
    machineName: "dev-machine",
    platform: "darwin",
    pluginVersion: "0.1.0",
    supportedOperations: ["git_action"],
    maxInFlightCommands: 4,
  };

  it("keeps legacy Desktop hello payloads backward compatible", () => {
    expect(parseHelloPayload(legacyHello)).toMatchObject({
      machineName: "dev-machine",
      gatewayId: undefined,
      desktopSecurityUpgradeProtocolVersion: undefined,
    });
  });

  // ISS-12435 (PLN-2182 AC-016): an installed Desktop build still declares the
  // retired loop operation ids; the hello must parse, not drop the connection.
  it("accepts an old Desktop hello that declares retired loop operations", () => {
    const retiredOperations = ["symphony_loop", "codex_review", "git_action"];
    expect(
      parseHelloPayload({
        ...legacyHello,
        supportedOperations: retiredOperations,
      })
    ).toMatchObject({ supportedOperations: retiredOperations });
  });

  it("preserves valid PLN-359 gateway metadata", () => {
    expect(
      parseHelloPayload({
        ...legacyHello,
        gatewayId: "550e8400-e29b-41d4-a716-446655440000",
        desktopSecurityUpgradeProtocolVersion: 1,
      })
    ).toMatchObject({
      gatewayId: "550e8400-e29b-41d4-a716-446655440000",
      desktopSecurityUpgradeProtocolVersion: 1,
    });
  });

  it("preserves desktop client and gateway protocol versions", () => {
    expect(
      parseHelloPayload({
        ...legacyHello,
        desktopClientVersion: "2.3.4",
        gatewayProtocolVersion: "0.1.0",
      })
    ).toMatchObject({
      desktopClientVersion: "2.3.4",
      gatewayProtocolVersion: "0.1.0",
    });
  });

  it("leaves desktop client and gateway protocol versions undefined when absent", () => {
    expect(parseHelloPayload(legacyHello)).toMatchObject({
      desktopClientVersion: undefined,
      gatewayProtocolVersion: undefined,
    });
  });

  it("preserves string gateway IDs without format validation", () => {
    expect(
      parseHelloPayload({
        ...legacyHello,
        gatewayId: "not-a-uuid",
        desktopSecurityUpgradeProtocolVersion: 99,
      })
    ).toMatchObject({
      gatewayId: "not-a-uuid",
      desktopSecurityUpgradeProtocolVersion: undefined,
    });
  });
});

describe("parseHelloPayload — maxInFlightCommands ceiling (ISS-8547)", () => {
  const helloWith = (maxInFlightCommands: number) => ({
    machineName: "dev-machine",
    platform: "darwin",
    pluginVersion: "0.1.0",
    supportedOperations: ["git_action"],
    maxInFlightCommands,
  });

  // The mutation this must kill: the declared value became the Prisma `take`
  // of the dispatch drain's queue read and then the width of a `Promise.all`
  // opening one relay POST per row, so it must never survive verbatim.
  it("clamps an unbounded declared ceiling to MAX_IN_FLIGHT_COMMANDS_CEILING", () => {
    expect(
      parseHelloPayload(helloWith(Number.MAX_SAFE_INTEGER))?.maxInFlightCommands
    ).toBe(MAX_IN_FLIGHT_COMMANDS_CEILING);
  });

  it("leaves a declared ceiling below the cap unchanged", () => {
    expect(parseHelloPayload(helloWith(2))?.maxInFlightCommands).toBe(2);
  });

  it("still floors a fractional in-range ceiling to an integer", () => {
    expect(parseHelloPayload(helloWith(4.7))?.maxInFlightCommands).toBe(4);
  });
});

describe("resolveOperationId — git/github prefix collision (ISS-8049)", () => {
  it("resolves the GitHub resync nudge path to its reserved operationId, not git_action", () => {
    expect(resolveOperationId(GITHUB_RESYNC_NUDGE_PATH)).toBe(
      GITHUB_RESYNC_NUDGE_OPERATION_ID
    );
  });

  it("keeps bare /api/gateway/git and its subpaths on git_action", () => {
    expect(resolveOperationId("/api/gateway/git")).toBe("git_action");
    expect(resolveOperationId("/api/gateway/git/worktree")).toBe("git_action");
  });

  it("leaves an unknown /api/gateway/github/* path unresolved so the dispatcher's operationId survives", () => {
    // A future reserved GitHub command must fall through to the
    // `?? operation.operationId` fallback, never be captured by the git prefix.
    expect(resolveOperationId("/api/gateway/github/future-endpoint")).toBe(
      null
    );
  });
});

describe("toWireCommandFromRelayOperation — resync nudge wiring (ISS-8049)", () => {
  it("preserves github_resync_nudge end to end on the wire", () => {
    // The production dispatch path: dirty-scope service → relay → desktop.
    // Before ISS-8049 this returned operationId "git_action" and every desktop
    // rejected the command as "operationId/path mismatch".
    const wire = toWireCommandFromRelayOperation({
      operationId: GITHUB_RESYNC_NUDGE_OPERATION_ID,
      params: {
        request: {
          method: "POST",
          path: GITHUB_RESYNC_NUDGE_PATH,
          headers: {},
          body: { scopes: [] },
        },
        commandId: "01a03aef-0000-7000-8000-000000000000",
      },
      streaming: false,
    });
    expect(wire).toMatchObject({
      operationId: GITHUB_RESYNC_NUDGE_OPERATION_ID,
      method: "POST",
      path: GITHUB_RESYNC_NUDGE_PATH,
    });
  });
});

describe("toWireCommandFromRelayOperation — timeoutMs clamping (ISS-8233)", () => {
  // The mapper now really warns, so every case below would otherwise print to
  // stderr. Silenced per-case, and restored per-case, so the two assertions on
  // this spy cannot inherit calls from a sibling.
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(log, "warn").mockImplementation(() => {
      // silenced; the call itself is asserted below
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // `RelayOperationDispatchRequest.params` is an unvalidated `JsonValue`, so
  // this mapper is the first and only place the value is bounded before it
  // reaches a desktop `setTimeout`.
  function wireFor(timeoutMs: unknown) {
    return toWireCommandFromRelayOperation({
      operationId: "health_check",
      params: {
        commandId: "01a03aef-0000-7000-8000-000000000000",
        request: { method: "GET", path: "/api/gateway/health-check" },
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      } as JsonValue,
      streaming: false,
    });
  }

  it("caps a delay past the 32-bit ceiling that Node would collapse to ~1ms", () => {
    // 2147483648 rode the wire verbatim; Node then fired the abort about a
    // millisecond after dispatch and reported it back to the caller as a
    // timeout. Asking for the longest timeout got you the shortest.
    expect(wireFor(2_147_483_648)?.timeoutMs).toBe(2_147_483_647);
    expect(wireFor(1e308)?.timeoutMs).toBe(2_147_483_647);
  });

  it("floors a sub-millisecond delay to 1 rather than to no timeout at all", () => {
    // 0.5 truncated to 0, the executor's `> 0` check failed, and no timeout was
    // armed — silently reinstating the unbounded hang FEA-2848 removed.
    // Asserting `undefined` here would pin that bug.
    expect(wireFor(0.5)?.timeoutMs).toBe(1);
  });

  it("omits a nonpositive timeout instead of flooring it onto the wire", () => {
    // A floor here would send 1 to the desktop and abort the command ~1ms after
    // dispatch. `0` and negatives have no short-timeout intent to preserve, so
    // they take the absent-timeout path they already take today.
    expect(wireFor(0)?.timeoutMs).toBeUndefined();
    expect(wireFor(-5)?.timeoutMs).toBeUndefined();
  });

  it("passes an ordinary timeout through unchanged", () => {
    expect(wireFor(30_000)?.timeoutMs).toBe(30_000);
  });

  it("leaves a non-numeric or absent timeout undefined, matching today", () => {
    expect(wireFor("30000")?.timeoutMs).toBeUndefined();
    expect(wireFor(Number.NaN)?.timeoutMs).toBeUndefined();
    expect(wireFor(undefined)?.timeoutMs).toBeUndefined();
  });

  it("surfaces a malformed relay timeout on the monitored warn", () => {
    // `params` is `z.unknown()` upstream, so this mapper is where server-side
    // bad cross-repo input becomes visible; coercing it away in silence is what
    // the Handling-Bad-Data rule forbids.
    wireFor(2_147_483_648);
    expect(warn).toHaveBeenCalledWith(
      "toWireCommandFromRelayOperation: malformed relay timeoutMs",
      expect.objectContaining({
        value: 2_147_483_648,
        clampedTo: 2_147_483_647,
      })
    );

    warn.mockClear();
    wireFor(30_000);
    wireFor(undefined);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not reject the command over a timeout it dislikes", () => {
    // Cross-repo contract: a version-skewed caller must not lose the whole
    // command because one field was out of range.
    expect(wireFor(2_147_483_648)).toMatchObject({
      operationId: "health_check",
      method: "GET",
      path: "/api/gateway/health-check",
    });
  });
});

describe("toWireCommandFromStore — timeoutMs clamping (ISS-8233)", () => {
  // The store→wire funnel. Reached by the REST create route, whose validator
  // bounds `timeoutMs` `.positive()` with no ceiling, and by rows persisted
  // before this fix — neither of which passes through the relay mappers.
  function storedWith(timeoutMs: number | undefined) {
    return toWireCommandFromStore({
      commandId: "01a03aef-0000-7000-8000-000000000000",
      operationId: "health_check",
      method: "GET",
      path: "/api/gateway/health-check",
      timeoutMs,
      createdAt: "2026-08-30T00:00:00.000Z",
    });
  }

  it("caps a stored delay past the 32-bit ceiling on replay", () => {
    // A value the REST validator accepts today, or a legacy row, would
    // otherwise ride the wire verbatim to an already-installed desktop that
    // has no clamp of its own.
    expect(storedWith(2_147_483_648).timeoutMs).toBe(2_147_483_647);
  });

  it("floors a stored sub-millisecond delay to 1 rather than to no timeout", () => {
    expect(storedWith(0.5).timeoutMs).toBe(1);
  });

  it("omits a nonpositive stored timeout rather than replaying it as 1", () => {
    expect(storedWith(0).timeoutMs).toBeUndefined();
    expect(storedWith(-5).timeoutMs).toBeUndefined();
    expect(JSON.stringify(storedWith(0))).not.toContain("timeoutMs");
  });

  it("replays an ordinary or absent stored timeout unchanged", () => {
    expect(storedWith(30_000).timeoutMs).toBe(30_000);
    expect(storedWith(undefined).timeoutMs).toBeUndefined();
  });

  it("omits an absent timeout on the wire rather than serializing null", () => {
    // Cross-repo contract: an old desktop reading `null` where it expects a
    // missing field is a different bug from the one this ticket closes.
    expect(JSON.stringify(storedWith(undefined))).not.toContain("timeoutMs");
  });
});
