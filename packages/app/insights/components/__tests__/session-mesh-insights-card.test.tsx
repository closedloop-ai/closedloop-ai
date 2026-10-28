import type { SessionMeshInsights } from "@repo/api/src/types/session-mesh";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionMeshInsightsCard } from "../session-mesh-insights-card";

function report(
  scope: "me" | "org",
  deliveries: Partial<SessionMeshInsights["deliveries"]> = {}
): SessionMeshInsights {
  return {
    scope: { kind: scope },
    window: {
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-25T00:00:00.000Z",
    },
    trend: [],
    participation: { active: 2, eligible: 5 },
    deliveries: {
      attempted: 5,
      delivered: 4,
      acknowledged: 3,
      useful: 2,
      conflictsResolved: 1,
      judged: 3,
      notUseful: 1,
      cantTell: 0,
      recipientActions: 2,
      ...deliveries,
    },
    requestResponseLatencyMs: null,
    estimatedTimeSavedMinutes: null,
    estimatedCostSavedUsd: 1.25,
    coordinationOverheadMs: 30_000,
    provenance: {
      availability: "partial",
      notes: ["Attributed estimates only."],
    },
  };
}

describe("Session Mesh Insights card", () => {
  it.each(["me", "org"] as const)(
    "labels %s population and keeps estimates distinct from observed metrics",
    (scope) => {
      render(
        <SessionMeshInsightsCard
          data={report(scope)}
          isError={false}
          isLoading={false}
        />
      );

      expect(
        screen.getByText(scope === "org" ? "your organization" : "this user", {
          exact: false,
        })
      ).toBeInTheDocument();
      expect(screen.getByText("$1.25")).toBeInTheDocument();
      expect(screen.getByText("Estimated cost saved")).toBeInTheDocument();
      expect(screen.getByText("Estimated time saved")).toBeInTheDocument();
      expect(screen.getByText("5 eligible")).toBeInTheDocument();
      expect(screen.getByText("<1 min")).toBeInTheDocument();
    }
  );

  it("renders the three states with denominators, never a bare count", () => {
    render(
      <SessionMeshInsightsCard
        data={report("org")}
        isError={false}
        isLoading={false}
      />
    );
    expect(screen.getByText("Delivered")).toBeInTheDocument();
    expect(screen.getByText("3 judged of 4 delivered")).toBeInTheDocument();
    expect(screen.getByText("2 useful of 3 judged")).toBeInTheDocument();
    expect(screen.getByText("1 not useful of 3 judged")).toBeInTheDocument();
    expect(
      screen.getByText("3 engaged of 4 delivered", { exact: false })
    ).toBeInTheDocument();
  });

  it("never renders an unrecorded value signal as a zero-value outcome", () => {
    render(
      <SessionMeshInsightsCard
        data={report("org", {
          delivered: 4061,
          acknowledged: 0,
          useful: 0,
          conflictsResolved: 0,
          judged: 0,
          notUseful: 0,
          cantTell: 0,
          recipientActions: 0,
        })}
        isError={false}
        isLoading={false}
      />
    );
    // "0 useful" and "0 judged of 4,061 delivered" are different sentences.
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(screen.getByText("4,061")).toBeInTheDocument();
    expect(screen.getByText("0 judged of 4,061 delivered")).toBeInTheDocument();
    expect(screen.getByText("0 useful of 0 judged")).toBeInTheDocument();
  });

  it("treats a signal an older server omits as unknown, and still states the denominator", () => {
    render(
      <SessionMeshInsightsCard
        data={report("org", {
          // `useful` is NOT optional, so an older server still sends it. A zero
          // here must not render the bare "0 useful" this card exists to stop.
          useful: 0,
          judged: undefined,
          notUseful: undefined,
          cantTell: undefined,
          recipientActions: undefined,
        })}
        isError={false}
        isLoading={false}
      />
    );
    expect(
      screen.getAllByText("not reported by this server", { exact: false })
        .length
    ).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(
      screen.getByText("0 useful of an unreported judged count")
    ).toBeInTheDocument();
  });

  it("renders a measured zero as zero once its producer is demonstrably live", () => {
    render(
      <SessionMeshInsightsCard
        data={report("org", { judged: 10, useful: 10, notUseful: 0 })}
        isError={false}
        isLoading={false}
      />
    );
    // judged > 0 proves the producer fired, so "0 not useful of 10 judged" is a
    // measurement — rendering it as unknown would delete a computed value.
    expect(screen.getByText("0 not useful of 10 judged")).toBeInTheDocument();
    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(1);
  });

  it("distinguishes loading and unavailable reporting from real measurements", () => {
    const { rerender } = render(
      <SessionMeshInsightsCard isError={false} isLoading />
    );
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();

    rerender(<SessionMeshInsightsCard isError isLoading={false} />);
    expect(
      screen.getByText("Session Mesh reporting is temporarily unavailable.")
    ).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });
});
