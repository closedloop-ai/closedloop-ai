import type { Metadata } from "next";
import { PRDEditorContainer } from "./prd-editor-container";

type PrdPageProps = {
  params: Promise<{ id: string }>;
};

export const metadata: Metadata = {
  title: "PRD",
  description: "Product Requirements Document",
};

export default async function PrdPage({ params }: PrdPageProps) {
  const { id } = await params;

  return <PRDEditorContainer id={id} />;
}
