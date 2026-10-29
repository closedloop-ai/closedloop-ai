import type { CreateDesktopCommandInput } from "@repo/api/src/types/compute-target";
import { describe, expect, it, vi } from "vitest";
import {
  fingerprintCommand,
  normalizeCommandInput,
} from "@/lib/desktop-command-fingerprint";

/**
 * Store-ingress normalization of `timeoutMs` (ISS-8233). The field is part of
 * the persisted `requestPayload` and therefore part of the idempotency hash, so
 * clamping it anywhere later than here leaves an invalid timer in the column
 * and makes the same effective timeout hash differently per transport.
 */

const MAX = 2_147_483_647;

function inputWith(over: Partial<CreateDesktopCommandInput> = {}) {
  return {
    operationId: "health_check",
    method: "POST",
    path: "/api/gateway/health-check",
    headers: {},
    body: null,
    ...over,
  } as CreateDesktopCommandInput;
}

describe("normalizeCommandInput — timeoutMs", () => {
  it("caps a delay past the 32-bit ceiling before it is hashed or written", () => {
    expect(
      normalizeCommandInput(inputWith({ timeoutMs: MAX + 1 })).timeoutMs
    ).toBe(MAX);
    expect(
      normalizeCommandInput(inputWith({ timeoutMs: 1e308 })).timeoutMs
    ).toBe(MAX);
  });

  it("floors a sub-millisecond delay to 1", () => {
    expect(normalizeCommandInput(inputWith({ timeoutMs: 0.5 })).timeoutMs).toBe(
      1
    );
  });

  it("deletes the key for a nonpositive delay rather than storing undefined", () => {
    // `stableStringify` must see the same shape as a request that never sent
    // the field, or two equivalent commands hash differently.
    for (const bad of [0, -5]) {
      const normalized = normalizeCommandInput(inputWith({ timeoutMs: bad }));
      expect(Object.hasOwn(normalized, "timeoutMs")).toBe(false);
    }
  });

  it("returns an in-range or absent input untouched", () => {
    const inRange = inputWith({ timeoutMs: 30_000 });
    expect(normalizeCommandInput(inRange)).toBe(inRange);
    const absent = inputWith();
    expect(normalizeCommandInput(absent)).toBe(absent);
  });

  it("reports a rejected value to the injected sink, and nothing otherwise", () => {
    const sink = vi.fn();
    normalizeCommandInput(inputWith({ timeoutMs: MAX + 1 }), sink);
    expect(sink).toHaveBeenCalledWith({ value: MAX + 1, clampedTo: MAX });

    sink.mockClear();
    normalizeCommandInput(inputWith({ timeoutMs: -5 }), sink);
    expect(sink).toHaveBeenCalledWith({ value: -5, clampedTo: undefined });

    sink.mockClear();
    normalizeCommandInput(inputWith({ timeoutMs: 30_000 }), sink);
    normalizeCommandInput(inputWith(), sink);
    expect(sink).not.toHaveBeenCalled();
  });
});

describe("fingerprintCommand — one hash per effective timeout (ISS-8233)", () => {
  it("hashes an out-of-range timeout the same as the value it clamps to", () => {
    // The defect whitlockk named on #6282: the REST route bounds `timeoutMs`
    // `.positive()` with NO ceiling while the relay mapper clamps, so the same
    // effective command arriving on the two transports produced two hashes and
    // a retry raised a false IdempotencyConflictError.
    const raw = fingerprintCommand(
      normalizeCommandInput(inputWith({ timeoutMs: MAX + 1 }))
    );
    const clamped = fingerprintCommand(inputWith({ timeoutMs: MAX }));
    expect(raw).toBe(clamped);
  });

  it("hashes a dropped timeout the same as one that was never sent", () => {
    const dropped = fingerprintCommand(
      normalizeCommandInput(inputWith({ timeoutMs: -5 }))
    );
    expect(dropped).toBe(fingerprintCommand(inputWith()));
  });

  it("still separates two genuinely different timeouts", () => {
    // Guards the pair above from passing by collapsing everything to one hash.
    expect(
      fingerprintCommand(
        normalizeCommandInput(inputWith({ timeoutMs: 30_000 }))
      )
    ).not.toBe(
      fingerprintCommand(
        normalizeCommandInput(inputWith({ timeoutMs: 60_000 }))
      )
    );
  });
});
