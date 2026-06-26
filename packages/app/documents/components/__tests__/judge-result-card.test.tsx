import { createMockJudgeFeedbackItem } from "@repo/app/shared/test-fixtures/evaluation";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { JudgeResultCard } from "../judge-result-card";

const mockMutateAsync = vi.fn();
const mockUseMyJudgeRatings = vi.fn();
const mockUseSubmitJudgeRating = vi.fn();

vi.mock("@repo/app/judges-analytics/hooks/use-my-judge-ratings", () => ({
  useMyJudgeRatings: (..._args: unknown[]) => mockUseMyJudgeRatings(),
}));

vi.mock("@repo/app/judges-analytics/hooks/use-submit-judge-rating", () => ({
  useSubmitJudgeRating: (..._args: unknown[]) => mockUseSubmitJudgeRating(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockUseMyJudgeRatings.mockReturnValue({ data: { ratings: [] } });
  mockUseSubmitJudgeRating.mockReturnValue({
    mutateAsync: mockMutateAsync,
    isPending: false,
  });
  mockMutateAsync.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
});

describe("JudgeResultCard", () => {
  test("shows failing state when effective score is below threshold", () => {
    mockUseMyJudgeRatings.mockReturnValue({
      data: {
        ratings: [{ judgeScoreId: "js-1", rating: 0.3 }],
      },
    });

    render(
      <JudgeResultCard
        documentId="artifact-1"
        item={createMockJudgeFeedbackItem({
          judgeScoreId: "js-1",
          score: 0.8,
          threshold: 0.7,
        })}
      />
    );

    expect(screen.getByText("Score: 30% (Failing)")).toBeDefined();
  });

  test("renders static score without editable input when documentId is missing", () => {
    render(
      <JudgeResultCard
        item={createMockJudgeFeedbackItem({
          score: 0.8,
          threshold: 0.7,
        })}
      />
    );

    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.getByText("Score: 80% (Passing)")).toBeDefined();
  });

  test("pre-populates editable input from existing user rating", () => {
    mockUseMyJudgeRatings.mockReturnValue({
      data: {
        ratings: [{ judgeScoreId: "js-1", rating: 0.55 }],
      },
    });

    render(
      <JudgeResultCard
        documentId="artifact-1"
        item={createMockJudgeFeedbackItem({
          judgeScoreId: "js-1",
          score: 0.9,
        })}
      />
    );

    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(input.value).toBe("0.55");
  });

  test("submits new value on blur when changed", async () => {
    render(
      <JudgeResultCard
        documentId="artifact-1"
        item={createMockJudgeFeedbackItem({
          judgeScoreId: "js-1",
          score: 0.8,
        })}
      />
    );

    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "0.6" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({
        judgeScoreId: "js-1",
        rating: 0.6,
      });
    });
  });

  test("does not submit value on blur when unchanged", () => {
    render(
      <JudgeResultCard
        documentId="artifact-1"
        item={createMockJudgeFeedbackItem({
          judgeScoreId: "js-1",
          score: 0.8,
        })}
      />
    );

    const input = screen.getByRole("spinbutton");
    fireEvent.blur(input);
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  test("shows validation error for out-of-range values", () => {
    render(
      <JudgeResultCard
        documentId="artifact-1"
        item={createMockJudgeFeedbackItem({
          judgeScoreId: "js-1",
          score: 0.8,
        })}
      />
    );

    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "1.5" } });
    fireEvent.blur(input);

    expect(screen.getByText("Must be between 0 and 1")).toBeDefined();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  test("reverts input to previous value when submit fails", async () => {
    mockMutateAsync.mockRejectedValue(new Error("failed"));

    render(
      <JudgeResultCard
        documentId="artifact-1"
        item={createMockJudgeFeedbackItem({
          judgeScoreId: "js-1",
          score: 0.8,
        })}
      />
    );

    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0.2" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(input.value).toBe("0.8");
    });
  });
});
