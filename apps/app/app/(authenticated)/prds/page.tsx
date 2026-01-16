import type { Metadata } from "next";
import { getArtifactsByType } from "@/app/actions/artifacts";
import { Header } from "../components/header";
import { NewPRDModal } from "./components/new-prd-modal";
import { PRDTable } from "./components/prd-table";

export const metadata: Metadata = {
  title: "PRD Library",
  description: "Product Requirements Documents",
};

export default async function PRDsPage() {
  const prdsResult = await getArtifactsByType("PRD");
  const prds = prdsResult.success ? prdsResult.data : [];

  return (
    <>
      <Header page="PRD Library" pages={["Product Requirements Documents"]}>
        <NewPRDModal />
      </Header>
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <PRDTable prds={prds} />
      </div>
    </>
  );
}
