import type { Metadata } from "next";
import { resolveOgMetadata } from "@/lib/og-metadata";
import { FeaturePageContainer } from "./feature-page-container";

type FeaturePageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({
  params,
}: FeaturePageProps): Promise<Metadata> {
  const { slug } = await params;
  return resolveOgMetadata(`features/${slug}`);
}

export default async function FeaturePage({ params }: FeaturePageProps) {
  const { slug } = await params;

  return <FeaturePageContainer slug={slug} />;
}
