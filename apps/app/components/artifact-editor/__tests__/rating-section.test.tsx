import type { ArtifactRatingSummary } from "@repo/api/src/types/rating";
import { cleanup, render, screen } from "@testing-library/react";
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

// Mock StarRating component to avoid dependencies
vi.mock("@repo/design-system/components/ui/star-rating", () => ({
  StarRating: ({ value }: { value: number }) => (
    <div data-testid="star-rating" data-value={value}>
      Star Rating: {value}
    </div>
  ),
}));

// Regex pattern for testing (hoisted to module level per Biome lint rules)
const SAVE_COMMENT_BUTTON_PATTERN = /save comment/i;

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
      expectedDisabled: false,
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
});
