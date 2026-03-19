import { notFound } from "next/navigation";
import { BranchViewContainer } from "./branch-view-container";
import { createStubBranchViewData } from "./stub-data";

type BuildPageProps = {
  params: Promise<{ id: string }>;
};

export default async function BuildPage({ params }: BuildPageProps) {
  const { id } = await params;
  if (!id) {
    notFound();
  }
  const data = createStubBranchViewData(id);
  return <BranchViewContainer data={data} />;
}
