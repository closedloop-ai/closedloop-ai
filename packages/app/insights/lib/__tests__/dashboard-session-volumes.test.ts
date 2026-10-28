import { SessionVolumeBucket } from "@repo/api/src/types/onboarding-analytics";
import { describe, expect, it } from "vitest";
import {
  type DashboardSessionVolumeReport,
  deriveDashboardSessionVolumeBuckets,
} from "../dashboard-session-volumes";

const VIEWER = "user-uuid-1";

function report(
  overrides: Partial<DashboardSessionVolumeReport> = {}
): DashboardSessionVolumeReport {
  return {
    orgSessionCount: 120,
    userSessionCounts: [
      { count: 4, userId: VIEWER },
      { count: 40, userId: "user-uuid-2" },
    ],
    ...overrides,
  };
}

describe("deriveDashboardSessionVolumeBuckets", () => {
  it("buckets the viewer's own count and the org count from windowed non-zero reads", () => {
    expect(
      deriveDashboardSessionVolumeBuckets({
        orgAllTimeZeroEstablished: false,
        report: report(),
        viewerUserId: VIEWER,
      })
    ).toEqual({
      orgAnalyzedSessionsVolume: SessionVolumeBucket.HundredPlus,
      ownAnalyzedSessionsVolume: SessionVolumeBucket.OneToNine,
    });
  });

  it("never crosses the activation boundary off a windowed zero: absent viewer and zero org fold to unknown", () => {
    expect(
      deriveDashboardSessionVolumeBuckets({
        orgAllTimeZeroEstablished: false,
        report: report({
          orgSessionCount: 0,
          userSessionCounts: [{ count: 40, userId: "user-uuid-2" }],
        }),
        viewerUserId: VIEWER,
      })
    ).toEqual({
      orgAnalyzedSessionsVolume: null,
      ownAnalyzedSessionsVolume: null,
    });
  });

  it('emits "0" for both properties only off the established all-time zero', () => {
    expect(
      deriveDashboardSessionVolumeBuckets({
        orgAllTimeZeroEstablished: true,
        report: report({ orgSessionCount: 0, userSessionCounts: [] }),
        viewerUserId: VIEWER,
      })
    ).toEqual({
      orgAnalyzedSessionsVolume: SessionVolumeBucket.Zero,
      ownAnalyzedSessionsVolume: SessionVolumeBucket.Zero,
    });
  });

  it("omits both buckets when the operands are genuinely absent", () => {
    expect(
      deriveDashboardSessionVolumeBuckets({
        orgAllTimeZeroEstablished: false,
        report: report({ orgSessionCount: null, userSessionCounts: null }),
        viewerUserId: null,
      })
    ).toEqual({
      orgAnalyzedSessionsVolume: null,
      ownAnalyzedSessionsVolume: null,
    });
  });
});
