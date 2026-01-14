import type { Metadata } from "next";
import { Header } from "../components/header";

export const metadata: Metadata = {
  title: "Implementation Plans",
  description: "Track implementation plans and progress",
};

const ImplementationPlansPage = () => {
  return (
    <>
      <Header page="Implementation Plans" pages={["Planning"]} />
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <div className="rounded-xl border bg-card p-6">
          <h1 className="text-2xl font-bold mb-2">Implementation Plans</h1>
          <p className="text-muted-foreground mb-4">
            Track and manage your implementation plans and development progress.
          </p>
          <div className="text-center text-muted-foreground py-8 border border-dashed rounded-lg">
            No implementation plans yet. Create your first plan to get started.
          </div>
        </div>
      </div>
    </>
  );
};

export default ImplementationPlansPage;
