import { notFound } from "next/navigation";
import { Header } from "@/app/(authenticated)/components/header";
import { getArtifacts } from "@/app/actions/artifacts";
import { getWorkstreamById } from "@/app/actions/workstreams";
import { WorkstreamDetail } from "./workstream-detail";

type WorkstreamPageProps = {
  params: Promise<{ id: string }>;
};

export default async function WorkstreamPage({ params }: WorkstreamPageProps) {
  const { id } = await params;
  const [workstreamResult, artifactsResult] = await Promise.all([
    getWorkstreamById(id),
    getArtifacts(id),
  ]);

  if (!workstreamResult.success) {
    notFound();
  }

  const workstream = workstreamResult.data;
  const artifacts = artifactsResult.success ? artifactsResult.data : [];

  return (
    <>
      <Header
        page={workstream.title}
        pages={["Workstreams", workstream.title]}
      />
      <main className="flex flex-1 flex-col p-4 pt-0">
        <WorkstreamDetail artifacts={artifacts} workstream={workstream} />
      </main>
    </>
  );
}
