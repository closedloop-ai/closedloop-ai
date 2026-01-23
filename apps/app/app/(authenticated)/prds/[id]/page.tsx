import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCachedArtifactById } from "@/lib/cached-data";
import { PRDEditor } from "./prd-editor";

type PrdPageProps = {
  params: Promise<{ id: string }>;
};

export const generateMetadata = async ({
  params,
}: PrdPageProps): Promise<Metadata> => {
  const { id } = await params;
  // Uses React.cache() to deduplicate with page component fetch
  const result = await getCachedArtifactById(id);

  return {
    title: result.success ? result.data.title : "PRD",
    description: "Product Requirements Document",
  };
};

const PrdPage = async ({ params }: PrdPageProps) => {
  const { id } = await params;
  // Uses React.cache() - deduplicates with generateMetadata fetch
  const result = await getCachedArtifactById(id);

  if (!result.success || result.data.type !== "PRD") {
    notFound();
  }

  const prd = result.data;

  return <PRDEditor prd={prd} />;
};

export default PrdPage;
