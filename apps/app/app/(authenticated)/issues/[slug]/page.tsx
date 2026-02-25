import type { Metadata } from "next";
import { generateArtifactMetadata } from "@/lib/artifact-metadata";
import { FeaturePageContainer } from "./feature-page-container";

type IssuePageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({
  params,
}: IssuePageProps): Promise<Metadata> {
  const { slug } = await params;
  return generateArtifactMetadata(slug);
}

export default async function IssuePage({ params }: IssuePageProps) {
  const { slug } = await params;

  return <FeaturePageContainer slug={slug} />;
}
