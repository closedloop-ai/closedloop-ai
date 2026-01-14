import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getPRDById } from "@/app/actions/prds";
import { PRDEditor } from "./prd-editor";

type PRDPageProps = {
  params: Promise<{ id: string }>;
};

export async function generateMetadata({ params }: PRDPageProps): Promise<Metadata> {
  const { id } = await params;
  const result = await getPRDById(id);

  if (result.error || !result.data) {
    return { title: "PRD Not Found" };
  }

  return {
    title: result.data.title,
    description: `PRD: ${result.data.title}`,
  };
}

export default async function PRDPage({ params }: PRDPageProps) {
  const { id } = await params;
  const result = await getPRDById(id);

  if (result.error || !result.data) {
    notFound();
  }

  return <PRDEditor prd={result.data} />;
}
