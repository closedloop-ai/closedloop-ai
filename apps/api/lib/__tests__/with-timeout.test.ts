import { DesktopHelloNackReason } from "@repo/api/src/types/compute-target";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTimeoutError, runStage } from "../with-timeout";

const LABEL = "stageLabel";
const TIMEOUT_MS = 5000;

describe("isTimeoutError", () => {
  const matchingMessage = `${LABEL} timed out after ${TIMEOUT_MS}ms`;

  const cases: {
    name: string;
    error: unknown;
    label: string;
    expected: boolean;
  }[] = [
    {
      name: "Error with matching label sentinel → true",
      error: new Error(matchingMessage),
      label: LABEL,
      expected: true,
    },
    {
      name: "Error from a different label → false",
      error: new Error("otherLabel timed out after 5000ms"),
      label: LABEL,
      expected: false,
    },
    {
      name: "Error with unrelated message → false",
      error: new Error("prisma connection refused"),
      label: LABEL,
      expected: false,
    },
    {
      name: "non-Error value (string) → false",
      error: `${LABEL} timed out after 5000ms`,
      label: LABEL,
      expected: false,
    },
    {
      name: "non-Error value (null) → false",
      error: null,
      label: LABEL,
      expected: false,
    },
  ];

  it.each(cases)("$name", ({ error, label, expected }) => {
    expect(isTimeoutError(error, label)).toBe(expected);
  });
});

describe("runStage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with ok: true when the promise settles before the deadline", async () => {
    const result = await runStage(
      Promise.resolve("value"),
      TIMEOUT_MS,
      LABEL,
      DesktopHelloNackReason.PendingCommandsLookupFailed
    );

    expect(result).toEqual({ ok: true, value: "value" });
  });

  it("resolves with ok: false and timeoutReason when the deadline expires", async () => {
    const resultPromise = runStage(
      new Promise<never>(() => {}),
      TIMEOUT_MS,
      LABEL,
      DesktopHelloNackReason.OnlineStateUpdateFailed
    );

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe(DesktopHelloNackReason.OnlineStateUpdateFailed);
    expect(isTimeoutError(result.cause, LABEL)).toBe(true);
  });

  it("uses timeoutReason for non-timeout rejection when failureReason is omitted", async () => {
    const cause = new Error("simulated prisma constraint");
    const result = await runStage(
      Promise.reject(cause),
      TIMEOUT_MS,
      LABEL,
      DesktopHelloNackReason.ComputeTargetUpdateFailed
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe(
      DesktopHelloNackReason.ComputeTargetUpdateFailed
    );
    expect(result.cause).toBe(cause);
  });

  it("uses failureReason for non-timeout rejection when supplied", async () => {
    const cause = new Error("network error");
    const result = await runStage(
      Promise.reject(cause),
      TIMEOUT_MS,
      LABEL,
      DesktopHelloNackReason.OnlineStateUpdateFailed,
      DesktopHelloNackReason.InternalError
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe(DesktopHelloNackReason.InternalError);
    expect(result.cause).toBe(cause);
  });
});
