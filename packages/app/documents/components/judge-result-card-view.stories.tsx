import type { JudgeFeedbackItem } from "@repo/api/src/types/evaluation";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { JudgeResultCardView } from "./judge-result-card-view";

const passingItem: JudgeFeedbackItem = {
  judgeScoreId: "judge-score-1",
  caseId: "case_accessibility",
  score: 0.92,
  threshold: 0.8,
  justification:
    "The document defines measurable requirements, includes edge cases, and keeps the acceptance criteria specific enough to validate.",
  finalStatus: "PASSED",
  promptName: "Accessibility rubric",
  metricName: "Accessibility coverage",
};

const failingItem: JudgeFeedbackItem = {
  judgeScoreId: "judge-score-2",
  caseId: "case_testability",
  score: 0.44,
  threshold: 0.75,
  justification:
    "The implementation outline is still high-level and does not define enough test cases or rollback behavior to be considered production-ready.",
  finalStatus: "FAILED",
  promptName: "Testability rubric",
  metricName: "Implementation testability",
};

/**
 * This card shows one automated judge's score on a document: a title, the
 * score, and whether it passed or failed, with the border and background
 * colored to match. Click the header to expand or collapse the written
 * justification behind that score. Switch it into editable mode and the
 * score becomes a number field you can correct by hand, complete with a
 * saving spinner and space for a validation error if the new value is
 * invalid.
 */
const meta = {
  title: "Composites/Documents/Judge Result Card View",
  component: JudgeResultCardView,
  tags: ["autodocs"],
  argTypes: {
    title: { control: "text", table: { category: "Content" } },
    justification: { control: "text", table: { category: "Content" } },
    scoreLabel: {
      control: "text",
      description:
        "The score as the caller wants it read. The component does not derive it from `score`.",
      table: { category: "Content" },
    },
    score: {
      control: { type: "number", min: 0, max: 1, step: 0.01 },
      table: { category: "Data" },
    },
    threshold: {
      control: { type: "number", min: 0, max: 1, step: 0.01 },
      description: "At or above this value the card reads as passing.",
      table: { category: "Data" },
    },
    defaultOpen: { control: "boolean", table: { category: "State" } },
    editable: { control: "boolean", table: { category: "State" } },
    inputValue: { control: "text", table: { category: "State" } },
    isSaving: { control: "boolean", table: { category: "State" } },
    validationError: { control: "text", table: { category: "State" } },
    onInputBlur: { control: false, table: { category: "Events" } },
    onInputChange: { control: false, table: { category: "Events" } },
  },
  args: {
    defaultOpen: true,
    editable: false,
    isSaving: false,
    justification: passingItem.justification,
    onInputBlur: fn(),
    onInputChange: fn(),
    score: passingItem.score,
    scoreLabel: "92%",
    threshold: passingItem.threshold,
    title: passingItem.metricName,
    validationError: null,
  },
} satisfies Meta<typeof JudgeResultCardView>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Passing: Story = {};

export const Failing: Story = {
  args: {
    justification: failingItem.justification,
    score: failingItem.score,
    scoreLabel: "44%",
    threshold: failingItem.threshold,
    title: failingItem.metricName,
  },
};

export const Collapsed: Story = {
  args: {
    defaultOpen: false,
  },
};

export const Editable: Story = {
  args: {
    editable: true,
    inputValue: "0.92",
    isSaving: false,
    justification: passingItem.justification,
    score: passingItem.score,
    scoreLabel: "92%",
    threshold: passingItem.threshold,
    title: passingItem.metricName,
    validationError: null,
  },
};
