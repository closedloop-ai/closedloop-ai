import type { Metadata } from "next";
import { getImplementationPlans } from "@/app/actions/implementation-plans";
import { Header } from "../components/header";
import { ImplementationPlanTable } from "./components/implementation-plan-table";
import { NewImplementationPlanModal } from "./components/new-implementation-plan-modal";

export const metadata: Metadata = {
  title: "Implementation Plans",
  description: "Implementation Plans generated from PRDs",
};

export default async function ImplementationPlansPage() {
  const result = await getImplementationPlans();
  const plans = result.success ? result.data : [];

  return (
    <>
      <Header page="Implementation Plans" pages={["Generated Plans from PRDs"]}>
        <NewImplementationPlanModal />
      </Header>
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <ImplementationPlanTable plans={plans} />
      </div>
    </>
  );
}
