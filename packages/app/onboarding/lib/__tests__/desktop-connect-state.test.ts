import { DesktopDeviceSessionStatus } from "@repo/api/src/types/onboarding";
import { describe, expect, it } from "vitest";
import type { DesktopDeviceSessionDetails } from "../../types";
import {
  DesktopConnectStateKind,
  deriveDesktopConnectState,
  getDesktopConnectStateCopy,
} from "../desktop-connect-state";

const NOW = 1_700_000_000_000;

function detail(
  overrides: Partial<DesktopDeviceSessionDetails> = {}
): DesktopDeviceSessionDetails {
  return {
    userCode: "ABCD1234",
    machineName: "Daniel-MBP",
    platform: "darwin",
    webAppOrigin: "https://app.closedloop.ai",
    status: DesktopDeviceSessionStatus.Pending,
    createdAt: new Date(NOW - 60_000).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    ...overrides,
  };
}

describe("deriveDesktopConnectState", () => {
  it("is idle with no code", () => {
    const state = deriveDesktopConnectState({
      hasCode: false,
      isLoading: false,
      now: NOW,
    });
    expect(state.kind).toBe(DesktopConnectStateKind.Idle);
  });

  it("is loading while the detail query is in flight", () => {
    const state = deriveDesktopConnectState({
      hasCode: true,
      isLoading: true,
      now: NOW,
    });
    expect(state.kind).toBe(DesktopConnectStateKind.Loading);
  });

  it("is pending for a live pending session", () => {
    const state = deriveDesktopConnectState({
      hasCode: true,
      isLoading: false,
      detail: detail(),
      now: NOW,
    });
    expect(state.kind).toBe(DesktopConnectStateKind.Pending);
    expect(state.detail).toBeDefined();
  });

  it("is session_expired for a pending session past its expiry", () => {
    const state = deriveDesktopConnectState({
      hasCode: true,
      isLoading: false,
      detail: detail({ expiresAt: new Date(NOW - 1).toISOString() }),
      now: NOW,
    });
    expect(state.kind).toBe(DesktopConnectStateKind.SessionExpired);
  });

  it("maps detail status approved -> already_used", () => {
    const state = deriveDesktopConnectState({
      hasCode: true,
      isLoading: false,
      detail: detail({ status: DesktopDeviceSessionStatus.Approved }),
      now: NOW,
    });
    expect(state.kind).toBe(DesktopConnectStateKind.AlreadyUsed);
  });

  it("maps detail status denied -> denied", () => {
    const state = deriveDesktopConnectState({
      hasCode: true,
      isLoading: false,
      detail: detail({ status: DesktopDeviceSessionStatus.Denied }),
      now: NOW,
    });
    expect(state.kind).toBe(DesktopConnectStateKind.Denied);
  });

  it("maps detail status expired -> session_expired", () => {
    const state = deriveDesktopConnectState({
      hasCode: true,
      isLoading: false,
      detail: detail({ status: DesktopDeviceSessionStatus.Expired }),
      now: NOW,
    });
    expect(state.kind).toBe(DesktopConnectStateKind.SessionExpired);
  });

  it("treats a 404 detail error as session_expired", () => {
    const state = deriveDesktopConnectState({
      hasCode: true,
      isLoading: false,
      detailError: { status: 404 },
      now: NOW,
    });
    expect(state.kind).toBe(DesktopConnectStateKind.SessionExpired);
  });

  it("treats a non-404 detail error as not_found", () => {
    const state = deriveDesktopConnectState({
      hasCode: true,
      isLoading: false,
      detailError: { status: 500 },
      now: NOW,
    });
    expect(state.kind).toBe(DesktopConnectStateKind.NotFound);
  });

  it("is not_found when the detail is absent without an error", () => {
    const state = deriveDesktopConnectState({
      hasCode: true,
      isLoading: false,
      detail: null,
      now: NOW,
    });
    expect(state.kind).toBe(DesktopConnectStateKind.NotFound);
  });

  it("prioritizes an approved action over the cached detail", () => {
    const state = deriveDesktopConnectState({
      hasCode: true,
      isLoading: false,
      // Cache may still report pending; the action result wins.
      detail: detail(),
      actionOutcome: { kind: "approved" },
      now: NOW,
    });
    expect(state.kind).toBe(DesktopConnectStateKind.ApprovedComplete);
  });

  it("maps a denied action to denied", () => {
    const state = deriveDesktopConnectState({
      hasCode: true,
      isLoading: false,
      detail: detail(),
      actionOutcome: { kind: "denied" },
      now: NOW,
    });
    expect(state.kind).toBe(DesktopConnectStateKind.Denied);
  });

  it("maps a 403 action error to forbidden", () => {
    const state = deriveDesktopConnectState({
      hasCode: true,
      isLoading: false,
      detail: detail(),
      actionOutcome: { kind: "error", status: 403 },
      now: NOW,
    });
    expect(state.kind).toBe(DesktopConnectStateKind.Forbidden);
  });

  it("maps a 404 action error on a live session to already_used", () => {
    const state = deriveDesktopConnectState({
      hasCode: true,
      isLoading: false,
      detail: detail(),
      actionOutcome: { kind: "error", status: 404 },
      now: NOW,
    });
    expect(state.kind).toBe(DesktopConnectStateKind.AlreadyUsed);
  });

  it("maps a 404 action error on an expired session to session_expired", () => {
    const state = deriveDesktopConnectState({
      hasCode: true,
      isLoading: false,
      detail: detail({ expiresAt: new Date(NOW - 1).toISOString() }),
      actionOutcome: { kind: "error", status: 404 },
      now: NOW,
    });
    expect(state.kind).toBe(DesktopConnectStateKind.SessionExpired);
  });

  it("falls back to the detail state for a transient action error", () => {
    const state = deriveDesktopConnectState({
      hasCode: true,
      isLoading: false,
      detail: detail(),
      actionOutcome: { kind: "error", status: 503 },
      now: NOW,
    });
    // A retryable 503 leaves the pending session approvable.
    expect(state.kind).toBe(DesktopConnectStateKind.Pending);
  });
});

describe("getDesktopConnectStateCopy", () => {
  const failureKinds = [
    DesktopConnectStateKind.OrgRequired,
    DesktopConnectStateKind.SessionExpired,
    DesktopConnectStateKind.AlreadyUsed,
    DesktopConnectStateKind.Denied,
    DesktopConnectStateKind.Forbidden,
    DesktopConnectStateKind.NotFound,
    DesktopConnectStateKind.ApprovedComplete,
  ];

  it("provides an actionable title and description for every terminal state", () => {
    for (const kind of failureKinds) {
      const copy = getDesktopConnectStateCopy(kind);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.description.length).toBeGreaterThan(0);
    }
  });
});
