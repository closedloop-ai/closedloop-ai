import { describe, expect, it } from "vitest";
import {
  makeBranchDetail,
  makeBranchSession,
} from "../../__tests__/branch-fixtures";
import {
  resolveBranchSessionCostSubtotal,
  resolveKnownBranchSessionCostSubtotal,
} from "../branch-session-cost";

describe("resolveBranchSessionCostSubtotal", () => {
  it("uses the full source residual scale for a loaded unstamped subset", () => {
    const detail = makeBranchDetail({
      attributedCostUsd: 15,
      estimatedCostUsd: 20,
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 10,
          evenSplitCostUsd: 10,
          ownerUserName: "Cosimo",
        }),
        makeBranchSession({
          sessionId: "s2",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 10,
          ownerUserName: "Tamsin",
        }),
      ],
    });

    const loadedSessions = detail.sessions.filter(
      (session) => session.sessionId === "s2"
    );

    expect(
      resolveBranchSessionCostSubtotal(detail, loadedSessions, detail.sessions)
    ).toBe(5);
  });
});

describe("resolveKnownBranchSessionCostSubtotal", () => {
  it("keeps all-unpriced loaded Session evidence unavailable", () => {
    const detail = makeBranchDetail({
      estimatedCostUsd: null,
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          estimatedCostUsd: null,
        }),
      ],
    });

    expect(
      resolveKnownBranchSessionCostSubtotal(detail, detail.sessions)
    ).toBeNull();
  });

  it("keeps known zero loaded Session evidence distinct from unavailable", () => {
    const detail = makeBranchDetail({
      estimatedCostUsd: null,
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          estimatedCostUsd: 0,
        }),
      ],
    });

    expect(resolveKnownBranchSessionCostSubtotal(detail, detail.sessions)).toBe(
      0
    );
  });

  it("does not let one real zero price an adjacent unpriced loaded Session", () => {
    const detail = makeBranchDetail({
      estimatedCostUsd: null,
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          estimatedCostUsd: 0,
        }),
        makeBranchSession({
          sessionId: "s2",
          estimatedCostUsd: null,
        }),
      ],
    });

    expect(
      resolveKnownBranchSessionCostSubtotal(detail, detail.sessions)
    ).toBeNull();
  });
});
