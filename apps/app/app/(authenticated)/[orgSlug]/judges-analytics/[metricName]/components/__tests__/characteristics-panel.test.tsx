import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import type { JudgeDetail } from "@repo/api/src/types/judges-analytics";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CharacteristicsPanel } from "../characteristics-panel";

vi.mock("../radar-chart", () => ({
  JudgeRadarChart: () => <div data-testid="judge-radar-chart" />,
}));

function makeJudge(overrides: Partial<JudgeDetail> = {}): JudgeDetail {
  return {
    reportType: EvaluationReportType.Plan,
    promptName: "clarity",
    displayName: "Clarity",
    latestPromptId: "prompt-1",
    scoreCount: 25,
    radarAxes: {
      stubbornness: 0.6,
      optimism: 0.4,
      polarity: 0.5,
      certainty: 0.7,
    },
    labels: [],
    promptText: "Rate the clarity of the document.",
    promptVersions: [],
    unknownVersionScoreCount: 0,
    ...overrides,
  };
}

describe("CharacteristicsPanel", () => {
  it("shows an insufficient-data alert when radarAxes is null", () => {
    render(<CharacteristicsPanel judge={makeJudge({ radarAxes: null })} />);

    expect(screen.getByText("Insufficient data")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Not enough scores recorded to compute radar axes and characteristics."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("No strong tendencies detected.")).toBeNull();
  });

  it("says no strong tendencies were detected when there is data but no labels", () => {
    render(<CharacteristicsPanel judge={makeJudge({ labels: [] })} />);

    expect(
      screen.getByText("No strong tendencies detected.")
    ).toBeInTheDocument();
    expect(screen.queryByText("Insufficient data")).toBeNull();
  });

  it("renders a badge for each detected characteristic label", () => {
    render(
      <CharacteristicsPanel
        judge={makeJudge({ labels: ["Stubborn", "Optimistic"] })}
      />
    );

    expect(screen.getByText("Stubborn")).toBeInTheDocument();
    expect(screen.getByText("Optimistic")).toBeInTheDocument();
    expect(screen.queryByText("No strong tendencies detected.")).toBeNull();
  });

  it("always renders the radar chart alongside the characteristics", () => {
    render(<CharacteristicsPanel judge={makeJudge()} />);

    expect(screen.getByTestId("judge-radar-chart")).toBeInTheDocument();
  });

  it("opens the metrics help popover with the axis explanations", () => {
    render(<CharacteristicsPanel judge={makeJudge()} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Explain judge chart metrics" })
    );

    expect(
      screen.getByText("How to interpret the chart axes")
    ).toBeInTheDocument();
    expect(screen.getByText("Stubbornness")).toBeInTheDocument();
  });
});
