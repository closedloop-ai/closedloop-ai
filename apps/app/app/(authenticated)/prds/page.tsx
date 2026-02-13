import type { Metadata } from "next";
import { Header } from "../components/header";
import { NewPRDModal } from "./components/new-prd-modal";
import { PRDTable } from "./components/prd-table";

export const metadata: Metadata = {
  title: "PRD Library",
  description: "Product Requirements Documents",
};

export default function PRDsPage() {
  return (
    <>
      <Header page="PRD Library" pages={["Product Requirements Documents"]}>
        <NewPRDModal />
      </Header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 pt-0">
        <PRDTable />
      </div>
    </>
  );
}
