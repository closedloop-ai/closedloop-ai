import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PRDEditorContainer } from "./prd-editor-container";

type PrdPageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ version?: string }>;
};

export const metadata: Metadata = {
  title: "PRD",
  description: "Product Requirements Document",
};

export default async function PrdPage({ params, searchParams }: PrdPageProps) {
  const { slug } = await params;
  const { version } = await searchParams;

  // Parse and validate version if provided
  let versionNumber: number | undefined;
  if (version) {
    versionNumber = Number.parseInt(version, 10);

    if (Number.isNaN(versionNumber) || versionNumber < 1) {
      notFound();
    }
  }

  return <PRDEditorContainer slug={slug} version={versionNumber} />;
}
