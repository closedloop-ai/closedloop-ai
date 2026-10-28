import { BranchCompatibilityRedirect } from "./branch-compatibility-redirect";

type BuildPageProps = {
  params: Promise<{ orgSlug: string; id: string }>;
};

export default async function BuildPage({ params }: BuildPageProps) {
  const { id, orgSlug } = await params;
  return (
    <BranchCompatibilityRedirect branchArtifactId={id} orgSlug={orgSlug} />
  );
}
