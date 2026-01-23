import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCachedArtifactById } from "@/lib/cached-data";
import { PlanEditor } from "./plan-editor";

type PlanPageProps = {
  params: Promise<{ id: string }>;
};

export const generateMetadata = async ({
  params,
}: PlanPageProps): Promise<Metadata> => {
  const { id } = await params;
  // Uses React.cache() to deduplicate with page component fetch
  const result = await getCachedArtifactById(id);

  return {
    title: result.success ? result.data.title : "Implementation Plan",
    description: "Implementation Plan",
  };
};

const ImplementationPlanPage = async ({ params }: PlanPageProps) => {
  const { id } = await params;
  // Uses React.cache() - deduplicates with generateMetadata fetch
  const result = await getCachedArtifactById(id);

  if (!result.success || result.data.type !== "IMPLEMENTATION_PLAN") {
    // notFound() throws a NEXT_NOT_FOUND error which triggers the not-found.tsx page
    notFound();
  }

  const plan = result.data;

  return <PlanEditor plan={plan} />;
};

export default ImplementationPlanPage;
