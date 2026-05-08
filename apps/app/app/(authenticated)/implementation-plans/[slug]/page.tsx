import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveOgMetadata } from "@/lib/og-metadata";
import { PlanEditorContainer } from "./plan-editor-container";

type PlanPageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ version?: string }>;
};

export async function generateMetadata({
  params,
}: PlanPageProps): Promise<Metadata> {
  const { slug } = await params;
  return resolveOgMetadata(`implementation-plans/${slug}`);
}

export default async function ImplementationPlanPage({
  params,
  searchParams,
}: PlanPageProps) {
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

  return <PlanEditorContainer slug={slug} version={versionNumber} />;
}
