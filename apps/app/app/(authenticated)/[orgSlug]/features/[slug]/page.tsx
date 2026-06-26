import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveOgMetadata } from "@/lib/og-metadata";
import { FeatureEditorContainer } from "./feature-editor-container";

type FeaturePageProps = {
  params: Promise<{ orgSlug: string; slug: string }>;
  searchParams: Promise<{ version?: string }>;
};

export async function generateMetadata({
  params,
}: FeaturePageProps): Promise<Metadata> {
  const { orgSlug, slug } = await params;
  return resolveOgMetadata(`${orgSlug}/features/${slug}`);
}

export default async function FeaturePage({
  params,
  searchParams,
}: Readonly<FeaturePageProps>) {
  const { slug } = await params;
  const { version } = await searchParams;

  let versionNumber: number | undefined;
  if (version) {
    versionNumber = Number.parseInt(version, 10);
    if (Number.isNaN(versionNumber) || versionNumber < 1) {
      notFound();
    }
  }

  return <FeatureEditorContainer slug={slug} version={versionNumber} />;
}
