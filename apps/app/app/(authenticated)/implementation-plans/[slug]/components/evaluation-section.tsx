import { EvaluationSection as SharedEvaluationSection } from "@/components/artifact-editor/evaluation-section";

type SharedProps = Parameters<typeof SharedEvaluationSection>[0];

export function EvaluationSection(props: SharedProps) {
  return <SharedEvaluationSection {...props} />;
}
