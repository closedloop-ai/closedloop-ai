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

/**
 * A collapsible 'Evaluation' section showing how an artifact scored against
 * its automated LLM judges: a progress bar and an 'X of Y judges accepted'
 * count once results are in. Before results exist, it shows one of two plain
 * messages instead of an empty bar: that it's waiting on judges, or that
 * none have run yet. The list of individual judge results below the bar is
 * passed in from outside, so this component only owns the summary, not the
 * per-judge cards.
 */
const meta = {
  title: "Composites/Documents/Evaluation Section View",
  component: EvaluationSectionView,
  tags: ["autodocs"],
  argTypes: {
    state: {
      control: { type: "radio" },
      options: ["awaiting", "empty", "ready"],
    },
    acceptedCount: { control: { type: "number", min: 0 } },
    totalCount: { control: { type: "number", min: 0 } },
    children: { control: false },
  },
  args: {
    defaultOpen: true,
    state: "ready",
    title: "Evaluation",
    awaitingMessage: "Awaiting LLM Judges feedback",
    emptyMessage: "No judges have been evaluated yet",
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
