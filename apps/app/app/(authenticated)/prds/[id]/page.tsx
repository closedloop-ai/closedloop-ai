import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getArtifactById } from "@/app/actions/artifacts";
import { PRDEditor } from "./prd-editor";

type PrdPageProps = {
  params: Promise<{ id: string }>;
};

export const generateMetadata = async ({
  params,
}: PrdPageProps): Promise<Metadata> => {
  const { id } = await params;
  const result = await getArtifactById(id);

  return {
    title: result.success ? result.data.title : "PRD",
    description: "Product Requirements Document",
  };
};

const PrdPage = async ({ params }: PrdPageProps) => {
  const { id } = await params;
  const result = await getArtifactById(id);

  if (!result.success || result.data.type !== "PRD") {
    notFound();
  }

  const prd = result.data;

  return <PRDEditor prd={prd} />;
};

export default PrdPage;
