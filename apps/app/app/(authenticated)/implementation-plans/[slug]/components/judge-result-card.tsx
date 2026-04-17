import { JudgeResultCard as SharedJudgeResultCard } from "@/components/document-editor/judge-result-card";

type SharedProps = Parameters<typeof SharedJudgeResultCard>[0];

export function JudgeResultCard(props: SharedProps) {
  return <SharedJudgeResultCard {...props} />;
}
