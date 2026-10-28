import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import type { JudgeDetail } from "@repo/api/src/types/judges-analytics";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PromptSection } from "../prompt-section";

const PROMPT_UNAVAILABLE_COPY = "Prompt not available";
const UNKNOWN_VERSION_ROW_LABEL = "Unknown";
const NO_VERSION_DATA_COPY = "No version data available";

function makeJudge(overrides: Partial<JudgeDetail> = {}): JudgeDetail {
  return {
    reportType: EvaluationReportType.Plan,
    promptName: "clarity",
    displayName: "Clarity",
    latestPromptId: "prompt-1",
    scoreCount: 25,
    radarAxes: null,
    labels: [],
    promptText: "Rate the clarity of the document.",
    promptVersions: [],
    unknownVersionScoreCount: 0,
    ...overrides,
  };
}

describe("PromptSection", () => {
  it("shows the latest prompt text when available", () => {
    render(
      <PromptSection judge={makeJudge({ promptText: "Rate clarity." })} />
    );

    expect(screen.getByText("Rate clarity.")).toBeInTheDocument();
    expect(screen.queryByText(PROMPT_UNAVAILABLE_COPY)).toBeNull();
  });

  it("says the prompt is not available when promptText is null", () => {
    render(<PromptSection judge={makeJudge({ promptText: null })} />);

    expect(screen.getByText(PROMPT_UNAVAILABLE_COPY)).toBeInTheDocument();
  });

  it("renders a row of formatted stats for each prompt version", () => {
    render(
      <PromptSection
        judge={makeJudge({
          promptVersions: [
            {
              promptId: "prompt-1",
              version: 2,
              scoreCount: 10,
              mean: 0.8,
              stdDev: 0.1,
              min: 0.5,
              max: 1,
              createdAt: "2026-01-01T00:00:00.000Z",
              radarAxes: null,
            },
          ],
        })}
      />
    );

    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(screen.getByText("80%")).toBeInTheDocument();
    expect(screen.getByText("10%")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("adds an Unknown row when scores exist with no associated prompt version", () => {
    render(
      <PromptSection judge={makeJudge({ unknownVersionScoreCount: 4 })} />
    );

    const unknownCell = screen.getByText(UNKNOWN_VERSION_ROW_LABEL);
    expect(unknownCell).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("omits the Unknown row when there are no unattributed scores", () => {
    render(
      <PromptSection
        judge={makeJudge({
          promptVersions: [
            {
              promptId: "prompt-1",
              version: 1,
              scoreCount: 5,
              mean: 0.5,
              stdDev: 0.05,
              min: 0.4,
              max: 0.6,
              createdAt: "2026-01-01T00:00:00.000Z",
              radarAxes: null,
            },
          ],
          unknownVersionScoreCount: 0,
        })}
      />
    );

    expect(screen.queryByText(UNKNOWN_VERSION_ROW_LABEL)).toBeNull();
  });

  it("says no version data is available when there are neither versions nor unknown scores", () => {
    render(
      <PromptSection
        judge={makeJudge({ promptVersions: [], unknownVersionScoreCount: 0 })}
      />
    );

    expect(screen.getByText(NO_VERSION_DATA_COPY)).toBeInTheDocument();
  });

  it("does not show the no-data row once at least one version exists", () => {
    render(
      <PromptSection
        judge={makeJudge({
          promptVersions: [
            {
              promptId: "prompt-1",
              version: 1,
              scoreCount: 5,
              mean: 0.5,
              stdDev: 0.05,
              min: 0.4,
              max: 0.6,
              createdAt: "2026-01-01T00:00:00.000Z",
              radarAxes: null,
            },
          ],
        })}
      />
    );

    expect(screen.queryByText(NO_VERSION_DATA_COPY)).toBeNull();
  });
});
