import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveOgMetadata } from "@/lib/og-metadata";
import { FeaturePageContainer } from "./feature-page-container";

type FeaturePageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ version?: string }>;
};

export async function generateMetadata({
  params,
}: FeaturePageProps): Promise<Metadata> {
  const { slug } = await params;
  return resolveOgMetadata(`features/${slug}`);
}

export default async function FeaturePage({
  params,
  searchParams,
}: FeaturePageProps) {
  const { slug } = await params;
  const { version } = await searchParams;

  let versionNumber: number | undefined;
  if (version) {
    versionNumber = Number.parseInt(version, 10);
    if (Number.isNaN(versionNumber) || versionNumber < 1) {
      notFound();
    }
  }

  return <FeaturePageContainer slug={slug} version={versionNumber} />;
}
