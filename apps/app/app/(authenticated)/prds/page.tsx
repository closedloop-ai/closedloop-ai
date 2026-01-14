import type { Metadata } from "next";
import { Header } from "../components/header";
import { getPRDs } from "@/app/actions/prds";
import { PRDTable } from "./components/prd-table";
import { NewPRDModal } from "./components/new-prd-modal";

export const metadata: Metadata = {
  title: "PRD Library",
  description: "Product Requirements Documents",
};

export default async function PRDsPage() {
  const result = await getPRDs();
  const prds = result.data ?? [];

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
