import type { ArtifactRatingSummary } from "@repo/api/src/types/rating";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createWrapper } from "@/hooks/queries/__tests__/test-utils";
import { RatingSection } from "../rating-section";

// Mock the rating hooks
const mockUseArtifactRating = vi.fn();
const mockUseSubmitRating = vi.fn();

vi.mock("@/hooks/queries/use-artifact-rating", () => ({
  useArtifactRating: () => mockUseArtifactRating(),
  useSubmitRating: () => mockUseSubmitRating(),
}));

// Mock StarRating component to avoid dependencies; supports onChange for testing selection
vi.mock("@/components/star-rating", () => ({
  StarRating: ({
    value,
    onChange,
  }: {
    value: number;
    onChange?: (score: number) => void;
  }) => (
    <div data-testid="star-rating" data-value={value}>
      Star Rating: {value}
      {onChange != null && (
        <button onClick={() => onChange(4)} type="button">
          Set 4 stars
        </button>
      )}
    </div>
  ),
}));

// Regex patterns for testing (hoisted to module level per Biome lint rules)
const SAVE_COMMENT_BUTTON_PATTERN = /save comment/i;
const EDIT_COMMENT_BUTTON_PATTERN = /edit comment/i;

describe("RatingSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock for useSubmitRating
    mockUseSubmitRating.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  const scenarios: Array<{
    name: string;
    summary: ArtifactRatingSummary;
    commentSectionVisible: boolean;
    expectedDisabled: boolean;
  }> = [
    {
      name: "no rating exists (userRating is null)",
      summary: { average: 0, count: 0, userRating: null },
      commentSectionVisible: false,
      expectedDisabled: true,
    },
    {
      name: "rating with valid score (4)",
      summary: {
        average: 4.0,
        count: 1,
        userRating: {
          id: "rating-1",
          userId: "user-1",
          score: 4,
          artifactVersion: 1,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        },
      },
      commentSectionVisible: true,
      expectedDisabled: true, // Save disabled when comment unchanged (no comment set)
    },
    {
      name: "rating with score 0 (edge case)",
      summary: {
        average: 0,
        count: 1,
        userRating: {
          id: "rating-1",
          userId: "user-1",
          score: 0,
          artifactVersion: 1,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        },
      },
      commentSectionVisible: false,
      expectedDisabled: true,
    },
  ];

  test.each(
    scenarios
  )("comment section visibility and Save button state when $name", ({
    summary,
    commentSectionVisible,
    expectedDisabled,
  }: {
    name: string;
    summary: ArtifactRatingSummary;
    commentSectionVisible: boolean;
    expectedDisabled: boolean;
  }) => {
    mockUseArtifactRating.mockReturnValue({
      data: summary,
      isLoading: false,
    });

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <RatingSection artifactId="test-123" currentPlanVersion={1} />
      </Wrapper>
    );

    const button = screen.queryByRole("button", {
      name: SAVE_COMMENT_BUTTON_PATTERN,
    });

    if (commentSectionVisible) {
      expect(button).not.toBeNull();
      expect(button?.hasAttribute("disabled")).toBe(expectedDisabled);
    } else {
      expect(button).toBeNull();
    }
  });

  test("prior comment is shown in editable textarea and Edit comment button is not present", () => {
    const priorComment = "My prior comment";
    mockUseArtifactRating.mockReturnValue({
      data: {
        average: 4.0,
        count: 1,
        userRating: {
          id: "rating-1",
          userId: "user-1",
          score: 4,
          comment: priorComment,
          artifactVersion: 1,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        },
      },
      isLoading: false,
    });

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <RatingSection artifactId="test-123" currentPlanVersion={1} />
      </Wrapper>
    );

    const textarea = screen.getByPlaceholderText("Add a comment (optional)");
    expect(textarea).toBeTruthy();
    expect((textarea as HTMLTextAreaElement).value).toBe(priorComment);
    expect(
      screen.queryByRole("button", { name: EDIT_COMMENT_BUTTON_PATTERN })
    ).toBeNull();
  });

  test("comment section is visible when user selects score before mutation completes", () => {
    mockUseArtifactRating.mockReturnValue({
      data: { average: 0, count: 0, userRating: null },
      isLoading: false,
    });

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <RatingSection artifactId="test-123" currentPlanVersion={1} />
      </Wrapper>
    );

    expect(
      screen.queryByPlaceholderText("Add a comment (optional)")
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Set 4 stars" }));

    expect(
      screen.getByPlaceholderText("Add a comment (optional)")
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: SAVE_COMMENT_BUTTON_PATTERN })
    ).toBeTruthy();
  });
});
