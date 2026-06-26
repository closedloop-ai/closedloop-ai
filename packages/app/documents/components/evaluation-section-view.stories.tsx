import type { JudgeFeedbackItem } from "@repo/api/src/types/evaluation";
import type { Meta, StoryObj } from "@storybook/react";
import { EvaluationSectionView } from "./evaluation-section-view";
import { JudgeResultCardView } from "./judge-result-card-view";

const judgeItems: JudgeFeedbackItem[] = [
  {
    judgeScoreId: "judge-score-1",
    caseId: "case_accessibility",
    score: 0.91,
    threshold: 0.8,
    justification:
      "The narrative is concrete, scoped, and broken into evaluable outcomes.",
    finalStatus: "PASSED",
    promptName: "Accessibility rubric",
    metricName: "Accessibility coverage",
  },
  {
    judgeScoreId: "judge-score-2",
    caseId: "case_testability",
    score: 0.62,
    threshold: 0.75,
    justification:
      "The plan still lacks enough test-specific detail to fully pass this rubric.",
    finalStatus: "FAILED",
    promptName: "Testability rubric",
    metricName: "Implementation testability",
  },
  {
    judgeScoreId: "judge-score-3",
    caseId: "case_rollout",
    score: 0.84,
    threshold: 0.8,
    justification:
      "The rollout section includes sequencing, ownership, and fallback criteria.",
    finalStatus: "PASSED",
    promptName: "Rollout rubric",
    metricName: "Rollout readiness",
  },
];

const meta = {
  title: "App Core/Documents/Evaluation Section View",
  component: EvaluationSectionView,
  tags: ["autodocs"],
  args: {
    defaultOpen: true,
    state: "ready",
    title: "Evaluation",
    acceptedCount: 2,
    totalCount: 3,
  },
} satisfies Meta<typeof EvaluationSectionView>;

export default meta;

type Story = StoryObj<typeof meta>;

export const WithResults: Story = {
  render: (args) => (
    <EvaluationSectionView {...args}>
      {judgeItems.map((item) => (
        <JudgeResultCardView
          defaultOpen
          justification={item.justification}
          key={item.judgeScoreId}
          score={item.score}
          scoreLabel={`${Math.round(item.score * 100)}%`}
          threshold={item.threshold}
          title={item.metricName || item.promptName || item.caseId}
        />
      ))}
    </EvaluationSectionView>
  ),
};

export const Empty: Story = {
  args: {
    state: "empty",
  },
};

export const AwaitingResults: Story = {
  args: {
    state: "awaiting",
  },
};
