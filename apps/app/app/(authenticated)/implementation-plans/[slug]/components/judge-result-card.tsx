import { JudgeResultCard as SharedJudgeResultCard } from "@/components/artifact-editor/judge-result-card";

type SharedProps = Parameters<typeof SharedJudgeResultCard>[0];

export function JudgeResultCard(props: SharedProps) {
  return <SharedJudgeResultCard {...props} />;
}
