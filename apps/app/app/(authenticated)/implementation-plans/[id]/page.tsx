import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getArtifactById } from "@/app/actions/artifacts";
import { PlanEditor } from "./plan-editor";

type PlanPageProps = {
  params: Promise<{ id: string }>;
};

export const generateMetadata = async ({
  params,
}: PlanPageProps): Promise<Metadata> => {
  const { id } = await params;
  const result = await getArtifactById(id);

  return {
    title: result.success ? result.data.title : "Implementation Plan",
    description: "Implementation Plan",
  };
};

const ImplementationPlanPage = async ({ params }: PlanPageProps) => {
  const { id } = await params;
  const result = await getArtifactById(id);

  if (!result.success || result.data.type !== "IMPLEMENTATION_PLAN") {
    notFound();
  }

  const plan = result.data;

  return <PlanEditor plan={plan} />;
};

export default ImplementationPlanPage;
