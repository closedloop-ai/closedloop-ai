import type { Metadata } from "next";
import { getArtifactsByType } from "@/app/actions/artifacts";
import { Header } from "../components/header";
import { NewPlanModal } from "./components/new-plan-modal";
import { PlanTable } from "./components/plan-table";

export const metadata: Metadata = {
  title: "Implementation Plans",
  description: "Implementation Plans",
};

export default async function ImplementationPlansPage() {
  const plansResult = await getArtifactsByType("IMPLEMENTATION_PLAN");
  const plans = plansResult.success ? plansResult.data : [];

  return (
    <>
      <Header page="Implementation Plans" pages={["Documents"]}>
        <NewPlanModal />
      </Header>
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <PlanTable plans={plans} />
      </div>
    </>
  );
}
