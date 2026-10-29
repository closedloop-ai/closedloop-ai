import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toEventWire, toStoredCommand } from "@/lib/desktop-command-mappers";

/**
 * `toStoredCommand` maps a raw `desktop_commands` row onto the `StoredCommand`
 * wire shape. Not exercised directly anywhere in the existing test suite
 * (only indirectly through `desktop-command-store` integration paths), so
 * every status value and the request-payload fallback are covered here.
 */
function baseRow(
  overrides: Partial<Parameters<typeof toStoredCommand>[0]> = {}
) {
  return {
    id: "cmd-1",
    computeTargetId: "target-1",
    operationId: "health_check",
    status: DesktopCommandStatus.Queued,
    requestPayload: { operationId: "health_check", method: "GET", path: "/x" },
    error: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    queuedAt: null,
    startedAt: null,
    finishedAt: null,
    lastSequenceAcked: 0,
    idempotencyKey: null,
    requestFingerprint: "fp-1",
    ...overrides,
  };
}

describe("toStoredCommand — status recognition", () => {
  it.each([
    DesktopCommandStatus.Queued,
    DesktopCommandStatus.Accepted,
    DesktopCommandStatus.Running,
    DesktopCommandStatus.Done,
    DesktopCommandStatus.Failed,
    DesktopCommandStatus.Cancelled,
    DesktopCommandStatus.Expired,
  ])("passes a recognized status %s through unchanged", (status) => {
    const result = toStoredCommand(baseRow({ status }));
    expect(result.status).toBe(status);
  });

  it("collapses an unrecognized stored status to failed", () => {
    // pins current behavior; looks odd because an unrecognized DB status
    // silently becomes "failed" rather than surfacing the corrupt value.
    const result = toStoredCommand(baseRow({ status: "not_a_real_status" }));
    expect(result.status).toBe(DesktopCommandStatus.Failed);
  });
});

describe("toStoredCommand — requestPayload fallback", () => {
  it("uses the stored requestPayload when it is a record", () => {
    const result = toStoredCommand(
      baseRow({
        requestPayload: {
          operationId: "health_check",
          method: "PUT",
          path: "/y",
        },
      })
    );
    expect(result.requestPayload).toEqual({
      operationId: "health_check",
      method: "PUT",
      path: "/y",
    });
  });

  it("falls back to a synthesized POST /api/gateway payload when the stored value is not a record", () => {
    const result = toStoredCommand(
      baseRow({ operationId: "op-x", requestPayload: null })
    );
    expect(result.requestPayload).toEqual({
      operationId: "op-x",
      method: "POST",
      path: "/api/gateway",
    });
  });
});

describe("toEventWire — createdAt default", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the provided createdAt when given", () => {
    const explicit = new Date("2026-02-02T00:00:00.000Z");
    const result = toEventWire("cmd-1", 1, "status", null, explicit);
    expect(result.createdAt).toBe(explicit.toISOString());
  });

  it("defaults createdAt to now when omitted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-03T00:00:00.000Z"));
    const result = toEventWire("cmd-1", 1, "status", null);
    expect(result.createdAt).toBe("2026-03-03T00:00:00.000Z");
  });
});
