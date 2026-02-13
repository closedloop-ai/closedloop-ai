import type { Metadata } from "next";
import { Header } from "../components/header";
import { NewPlanModal } from "./components/new-plan-modal";
import { PlanTable } from "./components/plan-table";

export const metadata: Metadata = {
  title: "Implementation Plans",
  description: "Implementation Plans",
};

export default function ImplementationPlansPage() {
  return (
    <>
      <Header page="Implementation Plans" pages={["Documents"]}>
        <NewPlanModal />
      </Header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 pt-0">
        <PlanTable />
      </div>
    </>
  );
}
