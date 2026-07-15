/**
 * Unit tests for apps/api/lib/awaiting-input-transition.ts
 *
 * Verifies isAwaitingInputTransition only reports a genuine null → non-null
 * flip into awaiting-input for a still-live, non-terminal run.
 */

import { SESSION_STATUS } from "@closedloop-ai/loops-api/session-status";
import { describe, expect, it } from "vitest";
import { isAwaitingInputTransition } from "@/lib/awaiting-input-transition";

const AWAITING = new Date("2026-07-12T10:00:00.000Z");
const AWAITING_LATER = new Date("2026-07-12T11:00:00.000Z");
const ENDED = new Date("2026-07-12T12:00:00.000Z");
const LIVE = SESSION_STATUS.WAITING;

describe("isAwaitingInputTransition", () => {
  it("fires when a live run first flips into awaiting-input", () => {
    expect(isAwaitingInputTransition(null, AWAITING, null, LIVE)).toBe(true);
  });

  it("does not fire on a re-sync of an already-awaiting run", () => {
    expect(
      isAwaitingInputTransition(AWAITING, AWAITING_LATER, null, LIVE)
    ).toBe(false);
  });

  it("does not fire when the run is no longer awaiting", () => {
    expect(isAwaitingInputTransition(AWAITING, null, null, LIVE)).toBe(false);
  });

  it("does not fire when the run never awaits input", () => {
    expect(isAwaitingInputTransition(null, null, null, LIVE)).toBe(false);
  });

  it("does not fire when the run has already ended", () => {
    expect(isAwaitingInputTransition(null, AWAITING, ENDED, LIVE)).toBe(false);
  });

  // FEA-2858: awaitingInputSince and sessionEndedAt are independent wire fields,
  // so a terminal run can carry a non-null awaitingInputSince with a null
  // endedAt. The surface (toAgentSessionState) classifies ERROR/ABANDONED as
  // Blocked and COMPLETED as Completed — never PendingApproval — so notifying
  // "needs your input" for those would contradict the surface.
  it("does not fire for an ERROR run even with awaitingInputSince set and no endedAt", () => {
    expect(
      isAwaitingInputTransition(null, AWAITING, null, SESSION_STATUS.ERROR)
    ).toBe(false);
  });

  it("does not fire for an ABANDONED run even with awaitingInputSince set and no endedAt", () => {
    expect(
      isAwaitingInputTransition(null, AWAITING, null, SESSION_STATUS.ABANDONED)
    ).toBe(false);
  });

  it("does not fire for a COMPLETED run even with awaitingInputSince set and no endedAt", () => {
    expect(
      isAwaitingInputTransition(null, AWAITING, null, SESSION_STATUS.COMPLETED)
    ).toBe(false);
  });

  it("still fires for the ACTIVE (non-terminal) status", () => {
    expect(
      isAwaitingInputTransition(null, AWAITING, null, SESSION_STATUS.ACTIVE)
    ).toBe(true);
  });

  it("fires when status is null/undefined (no terminal signal to exclude)", () => {
    expect(isAwaitingInputTransition(null, AWAITING, null, null)).toBe(true);
    expect(isAwaitingInputTransition(null, AWAITING, null, undefined)).toBe(
      true
    );
  });
});
