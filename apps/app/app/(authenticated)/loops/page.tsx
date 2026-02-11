import type { Metadata } from "next";
import { Header } from "../components/header";
import { LoopsTable } from "./components/loops-table";

export const metadata: Metadata = {
  title: "Loops",
  description: "View all AI agent execution loops",
};

export default function LoopsPage() {
  return (
    <>
      <Header page="Loops" pages={["Workspace"]} />
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <div>
          <h1 className="font-bold text-2xl">Loops</h1>
          <p className="text-muted-foreground">
            Track AI agent executions across your organization
          </p>
        </div>
        <LoopsTable />
      </div>
    </>
  );
}
