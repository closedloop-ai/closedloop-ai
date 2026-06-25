import type { DocumentRatingSummary } from "@repo/api/src/types/rating";
import { createWrapper } from "@repo/app/shared/test-utils";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RatingSection } from "../rating-section";

// Mock the rating hooks
const mockUseArtifactRating = vi.fn();
const mockUseSubmitRating = vi.fn();

vi.mock("@repo/app/ratings/hooks/use-document-rating", () => ({
  useDocumentRating: () => mockUseArtifactRating(),
  useSubmitRating: () => mockUseSubmitRating(),
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
    summary: DocumentRatingSummary;
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
          documentVersion: 1,
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
          documentVersion: 1,
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
    summary: DocumentRatingSummary;
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
        <RatingSection currentPlanVersion={1} documentId="test-123" />
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
          documentVersion: 1,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        },
      },
      isLoading: false,
    });

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <RatingSection currentPlanVersion={1} documentId="test-123" />
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
        <RatingSection currentPlanVersion={1} documentId="test-123" />
      </Wrapper>
    );

    expect(
      screen.queryByPlaceholderText("Add a comment (optional)")
    ).toBeNull();

    fireEvent.click(screen.getAllByRole("radio")[3]);

    expect(
      screen.getByPlaceholderText("Add a comment (optional)")
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: SAVE_COMMENT_BUTTON_PATTERN })
    ).toBeTruthy();
  });
});
