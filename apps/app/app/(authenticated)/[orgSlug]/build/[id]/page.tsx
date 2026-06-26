import { notFound } from "next/navigation";
import { BranchViewContainer } from "./branch-view-container";

type BuildPageProps = {
  params: Promise<{ orgSlug: string; id: string }>;
};

export default async function BuildPage({ params }: BuildPageProps) {
  const { id, orgSlug } = await params;
  if (!id) {
    notFound();
  }
  return <BranchViewContainer externalLinkId={id} orgSlug={orgSlug} />;
}
