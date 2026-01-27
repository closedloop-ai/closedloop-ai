import type { Metadata } from "next";
import { PlanEditorContainer } from "./plan-editor-container";

type PlanPageProps = {
  params: Promise<{ id: string }>;
};

export const metadata: Metadata = {
  title: "Implementation Plan",
  description: "Implementation Plan",
};

export default async function ImplementationPlanPage({
  params,
}: PlanPageProps) {
  const { id } = await params;

  return <PlanEditorContainer id={id} />;
}
