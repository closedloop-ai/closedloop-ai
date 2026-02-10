import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { generateArtifactMetadata } from "@/lib/artifact-metadata";
import { IssueEditorContainer } from "./issue-editor-container";

type IssuePageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ version?: string }>;
};

export async function generateMetadata({
  params,
}: IssuePageProps): Promise<Metadata> {
  const { slug } = await params;
  return generateArtifactMetadata(slug);
}

export default async function IssuePage({
  params,
  searchParams,
}: IssuePageProps) {
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

  return <IssueEditorContainer slug={slug} version={versionNumber} />;
}
