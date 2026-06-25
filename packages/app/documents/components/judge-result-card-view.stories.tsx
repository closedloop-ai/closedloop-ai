import type { JudgeFeedbackItem } from "@repo/api/src/types/evaluation";
import type { Meta, StoryObj } from "@storybook/react";
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

const meta = {
  title: "App Core/Documents/Judge Result Card View",
  component: JudgeResultCardView,
  tags: ["autodocs"],
  args: {
    defaultOpen: true,
    justification: passingItem.justification,
    score: passingItem.score,
    scoreLabel: "92%",
    threshold: passingItem.threshold,
    title: passingItem.metricName,
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
    onInputBlur: () => undefined,
    onInputChange: () => undefined,
    score: passingItem.score,
    scoreLabel: "92%",
    threshold: passingItem.threshold,
    title: passingItem.metricName,
    validationError: null,
  },
};
