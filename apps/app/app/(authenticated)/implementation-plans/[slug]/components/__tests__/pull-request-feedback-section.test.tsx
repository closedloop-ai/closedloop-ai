import type { PullRequestRatingSummary } from "@repo/api/src/types/pull-request-rating";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createWrapper } from "@/hooks/queries/__tests__/test-utils";
import { PullRequestFeedbackSection } from "../pull-request-feedback-section";

// Mock the rating hooks
const mockUsePullRequestRating = vi.fn();
const mockUseSubmitPullRequestRating = vi.fn();

vi.mock("@/hooks/queries/use-pull-request-rating", () => ({
  usePullRequestRating: () => mockUsePullRequestRating(),
  useSubmitPullRequestRating: () => mockUseSubmitPullRequestRating(),
}));

// Mock StarRating component to avoid dependencies; supports onChange for testing selection
vi.mock("@/components/star-rating", () => ({
  StarRating: ({
    value,
    onChange,
    readonly,
  }: {
    value: number;
    onChange?: (score: number) => void;
    readonly?: boolean;
  }) => (
    <div data-testid="star-rating" data-value={value}>
      Star Rating: {value}
      {onChange != null && !readonly && (
        <>
          <button onClick={() => onChange(4)} type="button">
            Set 4 stars
          </button>
          <button onClick={() => onChange(0)} type="button">
            Clear rating
          </button>
        </>
      )}
    </div>
  ),
}));

// Regex patterns for testing (component uses "Save" not "Save Comment")
const SAVE_BUTTON_PATTERN = /^save$/i;
const CANCEL_BUTTON_PATTERN = /cancel/i;
const AVERAGE_PATTERN = /average/;
const RATINGS_PLURAL_PATTERN = /ratings/;

describe("PullRequestFeedbackSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock for useSubmitPullRequestRating
    mockUseSubmitPullRequestRating.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  const scenarios: Array<{
    name: string;
    summary: PullRequestRatingSummary;
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
          comment: "Some comment",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        },
      },
      commentSectionVisible: true,
      expectedDisabled: true, // Save disabled when comment unchanged
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
          comment: "x",
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
    summary: PullRequestRatingSummary;
    commentSectionVisible: boolean;
    expectedDisabled: boolean;
  }) => {
    mockUsePullRequestRating.mockReturnValue({
      data: summary,
      isLoading: false,
    });

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <PullRequestFeedbackSection pullRequestId="pr-123" />
      </Wrapper>
    );

    const button = screen.queryByRole("button", {
      name: SAVE_BUTTON_PATTERN,
    });

    if (commentSectionVisible) {
      expect(button).not.toBeNull();
      expect(button?.hasAttribute("disabled")).toBe(expectedDisabled);
    } else {
      expect(button).toBeNull();
    }
  });

  test("prior comment is shown in editable textarea", () => {
    const priorComment = "My prior comment";
    mockUsePullRequestRating.mockReturnValue({
      data: {
        average: 4.0,
        count: 1,
        userRating: {
          id: "rating-1",
          userId: "user-1",
          score: 4,
          comment: priorComment,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        },
      },
      isLoading: false,
    });

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <PullRequestFeedbackSection pullRequestId="pr-123" />
      </Wrapper>
    );

    const textarea = screen.getByPlaceholderText(
      "Add context for your rating (required)..."
    );
    expect(textarea).toBeTruthy();
    expect((textarea as HTMLTextAreaElement).value).toBe(priorComment);
  });

  test("comment section is visible when user selects score before mutation completes", () => {
    mockUsePullRequestRating.mockReturnValue({
      data: { average: 0, count: 0, userRating: null },
      isLoading: false,
    });

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <PullRequestFeedbackSection pullRequestId="pr-123" />
      </Wrapper>
    );

    expect(
      screen.queryByPlaceholderText("Add context for your rating (required)...")
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Set 4 stars" }));

    expect(
      screen.getByPlaceholderText("Add context for your rating (required)...")
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: SAVE_BUTTON_PATTERN })
    ).toBeTruthy();
  });

  test("displays loading skeleton when isLoading is true", () => {
    mockUsePullRequestRating.mockReturnValue({
      data: undefined,
      isLoading: true,
    });

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <PullRequestFeedbackSection pullRequestId="pr-123" />
      </Wrapper>
    );

    expect(screen.getByText("PR Feedback")).toBeTruthy();
    expect(screen.queryByTestId("star-rating")).toBeNull();
  });

  test("displays aggregate statistics when ratings exist", () => {
    mockUsePullRequestRating.mockReturnValue({
      data: {
        average: 4.5,
        count: 3,
        userRating: {
          id: "rating-1",
          userId: "user-1",
          score: 5,
          comment: "Great",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      isLoading: false,
    });

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <PullRequestFeedbackSection pullRequestId="pr-123" />
      </Wrapper>
    );

    expect(screen.getByText("4.5 average (3 ratings)")).toBeTruthy();
  });

  test("displays singular 'rating' for count of 1", () => {
    mockUsePullRequestRating.mockReturnValue({
      data: {
        average: 5.0,
        count: 1,
        userRating: {
          id: "rating-1",
          userId: "user-1",
          score: 5,
          comment: "Nice",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      isLoading: false,
    });

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <PullRequestFeedbackSection pullRequestId="pr-123" />
      </Wrapper>
    );

    expect(screen.getByText("5.0 average (1 rating)")).toBeTruthy();
    expect(screen.queryByText(RATINGS_PLURAL_PATTERN)).toBeNull();
  });

  test("does not display aggregate when count is 0", () => {
    mockUsePullRequestRating.mockReturnValue({
      data: {
        average: 0,
        count: 0,
        userRating: null,
      },
      isLoading: false,
    });

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <PullRequestFeedbackSection pullRequestId="pr-123" />
      </Wrapper>
    );

    expect(screen.queryByText(AVERAGE_PATTERN)).toBeNull();
  });

  test("calls mutate with score and comment when Save Comment is clicked", () => {
    const mutateFn = vi.fn();
    mockUseSubmitPullRequestRating.mockReturnValue({
      mutate: mutateFn,
      isPending: false,
    });

    mockUsePullRequestRating.mockReturnValue({
      data: {
        average: 4.0,
        count: 1,
        userRating: {
          id: "rating-1",
          userId: "user-1",
          score: 4,
          comment: "Old comment",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      isLoading: false,
    });

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <PullRequestFeedbackSection pullRequestId="pr-123" />
      </Wrapper>
    );

    const textarea = screen.getByPlaceholderText(
      "Add context for your rating (required)..."
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "New comment" } });

    const saveButton = screen.getByRole("button", {
      name: SAVE_BUTTON_PATTERN,
    });
    fireEvent.click(saveButton);

    expect(mutateFn).toHaveBeenCalledWith({
      pullRequestId: "pr-123",
      score: 4,
      comment: "New comment",
    });
  });

  test("Save button is disabled when comment is empty after star selection", () => {
    const mutateFn = vi.fn();
    mockUseSubmitPullRequestRating.mockReturnValue({
      mutate: mutateFn,
      isPending: false,
    });

    mockUsePullRequestRating.mockReturnValue({
      data: { average: 0, count: 0, userRating: null },
      isLoading: false,
    });

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <PullRequestFeedbackSection pullRequestId="pr-123" />
      </Wrapper>
    );

    fireEvent.click(screen.getByRole("button", { name: "Set 4 stars" }));
    const saveButton = screen.getByRole("button", {
      name: SAVE_BUTTON_PATTERN,
    });
    expect(saveButton.hasAttribute("disabled")).toBe(true);
    expect(mutateFn).not.toHaveBeenCalled();
  });

  test("calls mutate with score and comment when Save is clicked after star selection and comment entered", () => {
    const mutateFn = vi.fn();
    mockUseSubmitPullRequestRating.mockReturnValue({
      mutate: mutateFn,
      isPending: false,
    });

    mockUsePullRequestRating.mockReturnValue({
      data: { average: 0, count: 0, userRating: null },
      isLoading: false,
    });

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <PullRequestFeedbackSection pullRequestId="pr-123" />
      </Wrapper>
    );

    fireEvent.click(screen.getByRole("button", { name: "Set 4 stars" }));
    const textarea = screen.getByPlaceholderText(
      "Add context for your rating (required)..."
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "My comment" } });
    fireEvent.click(screen.getByRole("button", { name: SAVE_BUTTON_PATTERN }));

    expect(mutateFn).toHaveBeenCalledWith({
      pullRequestId: "pr-123",
      score: 4,
      comment: "My comment",
    });
  });

  test("does not call mutate when score is 0 (guard)", () => {
    const mutateFn = vi.fn();
    mockUseSubmitPullRequestRating.mockReturnValue({
      mutate: mutateFn,
      isPending: false,
    });

    mockUsePullRequestRating.mockReturnValue({
      data: {
        average: 4.0,
        count: 1,
        userRating: {
          id: "rating-1",
          userId: "user-1",
          score: 4,
          comment: "OK",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      isLoading: false,
    });

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <PullRequestFeedbackSection pullRequestId="pr-123" />
      </Wrapper>
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear rating" }));

    expect(mutateFn).not.toHaveBeenCalled();
  });

  test("Cancel button resets comment to previous value", () => {
    mockUsePullRequestRating.mockReturnValue({
      data: {
        average: 4.0,
        count: 1,
        userRating: {
          id: "rating-1",
          userId: "user-1",
          score: 4,
          comment: "Original comment",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      isLoading: false,
    });

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <PullRequestFeedbackSection pullRequestId="pr-123" />
      </Wrapper>
    );

    const textarea = screen.getByPlaceholderText(
      "Add context for your rating (required)..."
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("Original comment");

    fireEvent.change(textarea, { target: { value: "Modified comment" } });
    expect(textarea.value).toBe("Modified comment");

    const cancelButton = screen.getByRole("button", {
      name: CANCEL_BUTTON_PATTERN,
    });
    fireEvent.click(cancelButton);

    expect(textarea.value).toBe("Original comment");
  });

  test("Save Comment button is disabled when comment is unchanged", () => {
    mockUsePullRequestRating.mockReturnValue({
      data: {
        average: 4.0,
        count: 1,
        userRating: {
          id: "rating-1",
          userId: "user-1",
          score: 4,
          comment: "Existing comment",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      isLoading: false,
    });

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <PullRequestFeedbackSection pullRequestId="pr-123" />
      </Wrapper>
    );

    const saveButton = screen.getByRole("button", {
      name: SAVE_BUTTON_PATTERN,
    });
    expect(saveButton.hasAttribute("disabled")).toBe(true);
  });

  test("Save button is disabled when comment is cleared to empty", () => {
    mockUsePullRequestRating.mockReturnValue({
      data: {
        average: 4.0,
        count: 1,
        userRating: {
          id: "rating-1",
          userId: "user-1",
          score: 4,
          comment: "Existing",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      isLoading: false,
    });

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <PullRequestFeedbackSection pullRequestId="pr-123" />
      </Wrapper>
    );

    const textarea = screen.getByPlaceholderText(
      "Add context for your rating (required)..."
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "" } });

    const saveButton = screen.getByRole("button", {
      name: SAVE_BUTTON_PATTERN,
    });
    expect(saveButton.hasAttribute("disabled")).toBe(true);
  });

  test("Save Comment button is enabled when comment is modified", () => {
    mockUsePullRequestRating.mockReturnValue({
      data: {
        average: 4.0,
        count: 1,
        userRating: {
          id: "rating-1",
          userId: "user-1",
          score: 4,
          comment: "Original comment",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      isLoading: false,
    });

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <PullRequestFeedbackSection pullRequestId="pr-123" />
      </Wrapper>
    );

    const textarea = screen.getByPlaceholderText(
      "Add context for your rating (required)..."
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Modified comment" } });

    const saveButton = screen.getByRole("button", {
      name: SAVE_BUTTON_PATTERN,
    });
    expect(saveButton.hasAttribute("disabled")).toBe(false);
  });

  test("displays character count in comment section", () => {
    mockUsePullRequestRating.mockReturnValue({
      data: {
        average: 4.0,
        count: 1,
        userRating: {
          id: "rating-1",
          userId: "user-1",
          score: 4,
          comment: "Hi",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      isLoading: false,
    });

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <PullRequestFeedbackSection pullRequestId="pr-123" />
      </Wrapper>
    );

    expect(screen.getByText("2 / 500")).toBeTruthy();

    const textarea = screen.getByPlaceholderText(
      "Add context for your rating (required)..."
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Hello" } });

    expect(screen.getByText("5 / 500")).toBeTruthy();
  });

  test("star rating is readonly when mutation is pending", () => {
    mockUseSubmitPullRequestRating.mockReturnValue({
      mutate: vi.fn(),
      isPending: true,
    });

    mockUsePullRequestRating.mockReturnValue({
      data: {
        average: 4.0,
        count: 1,
        userRating: {
          id: "rating-1",
          userId: "user-1",
          score: 4,
          comment: "Good",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      isLoading: false,
    });

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <PullRequestFeedbackSection pullRequestId="pr-123" />
      </Wrapper>
    );

    // When readonly=true, our mock doesn't render the buttons
    expect(screen.queryByRole("button", { name: "Set 4 stars" })).toBeNull();
  });
});
