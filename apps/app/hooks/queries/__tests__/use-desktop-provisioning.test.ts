import {
  DesktopProvisioningAttemptStatus,
  DesktopProvisioningReadinessStatus,
} from "@repo/api/src/types/electron";
import { describe, expect, it } from "vitest";
import {
  getDesktopProvisioningAttemptRefetchInterval,
  getDesktopProvisioningReadinessRefetchInterval,
} from "../use-desktop-provisioning";

describe("desktop provisioning query polling", () => {
  it("stops attempt polling on request errors and terminal attempt statuses", () => {
    expect(
      getDesktopProvisioningAttemptRefetchInterval({
        state: { status: "error" },
      })
    ).toBe(false);
    expect(
      getDesktopProvisioningAttemptRefetchInterval({
        state: {
          status: "success",
          data: {
            onboardingAttemptId: "attempt-1",
            expiresAt: "2026-04-27T18:00:00.000Z",
            status: DesktopProvisioningAttemptStatus.Complete,
          },
        },
      })
    ).toBe(false);
    expect(
      getDesktopProvisioningAttemptRefetchInterval({
        state: {
          status: "success",
          data: {
            onboardingAttemptId: "attempt-1",
            expiresAt: "2026-04-27T18:00:00.000Z",
            status: DesktopProvisioningAttemptStatus.Expired,
          },
        },
      })
    ).toBe(false);
  });

  it("continues attempt polling before terminal statuses", () => {
    expect(
      getDesktopProvisioningAttemptRefetchInterval({
        state: {
          status: "success",
          data: {
            onboardingAttemptId: "attempt-1",
            expiresAt: "2026-04-27T18:00:00.000Z",
            status: DesktopProvisioningAttemptStatus.Pending,
          },
        },
      })
    ).toBe(5000);
    expect(
      getDesktopProvisioningAttemptRefetchInterval({
        state: {
          status: "success",
          data: {
            onboardingAttemptId: "attempt-1",
            expiresAt: "2026-04-27T18:00:00.000Z",
            status: DesktopProvisioningAttemptStatus.Claimed,
          },
        },
      })
    ).toBe(5000);
  });

  it("stops readiness polling on request errors and complete readiness", () => {
    expect(
      getDesktopProvisioningReadinessRefetchInterval({
        state: { status: "error" },
      })
    ).toBe(false);
    expect(
      getDesktopProvisioningReadinessRefetchInterval({
        state: {
          status: "success",
          data: {
            status: DesktopProvisioningReadinessStatus.Complete,
            gatewayId: "gateway-1",
            computeTargetId: "target-1",
          },
        },
      })
    ).toBe(false);
  });

  it("continues readiness polling while readiness remains incomplete", () => {
    expect(
      getDesktopProvisioningReadinessRefetchInterval({
        state: {
          status: "success",
          data: { status: DesktopProvisioningReadinessStatus.Incomplete },
        },
      })
    ).toBe(10_000);
  });
});
