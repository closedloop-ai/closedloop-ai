import type { Metadata } from "next";
import { Header } from "../components/header";

export const metadata: Metadata = {
  title: "PRDs",
  description: "Product Requirements Documents",
};

const PRDsPage = () => {
  return (
    <>
      <Header page="PRDs" pages={["Product Requirements Documents"]} />
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <div className="rounded-xl border bg-card p-6">
          <h1 className="text-2xl font-bold mb-2">Product Requirements Documents</h1>
          <p className="text-muted-foreground mb-4">
            Manage and track your product requirements documents here.
          </p>
          <div className="text-center text-muted-foreground py-8 border border-dashed rounded-lg">
            No PRDs yet. Create your first PRD to get started.
          </div>
        </div>
      </div>
    </>
  );
};

export default PRDsPage;
