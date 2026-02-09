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
    expectedDisabled: boolean;
  }> = [
    {
      name: "no rating exists (userRating is null)",
      summary: { average: 0, count: 0, userRating: null },
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
      expectedDisabled: true,
    },
  ];

  test.each(scenarios)(
    ({
      name,
      expectedDisabled,
    }: {
      name: string;
      summary: ArtifactRatingSummary;
      expectedDisabled: boolean;
    }) =>
      `Save Comment button is ${expectedDisabled ? "disabled" : "enabled"} when ${name}`,
    ({
      summary,
      expectedDisabled,
    }: {
      name: string;
      summary: ArtifactRatingSummary;
      expectedDisabled: boolean;
    }) => {
      // Mock useArtifactRating to return the scenario's summary
      mockUseArtifactRating.mockReturnValue({
        data: summary,
        isLoading: false,
      });

      // Render RatingSection with artifactId="test-123" and currentPlanVersion={1}
      const Wrapper = createWrapper();
      render(
        <Wrapper>
          <RatingSection artifactId="test-123" currentPlanVersion={1} />
        </Wrapper>
      );

      // Find button using screen.getByRole("button", { name: SAVE_COMMENT_BUTTON_PATTERN })
      const button = screen.getByRole("button", {
        name: SAVE_COMMENT_BUTTON_PATTERN,
      });

      // Assert disabled state
      if (expectedDisabled) {
        expect(button).toBeDisabled();
      } else {
        expect(button).not.toBeDisabled();
      }
    }
  );
});
