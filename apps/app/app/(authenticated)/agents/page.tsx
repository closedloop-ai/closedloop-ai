import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import type { Metadata } from "next";
import { Header } from "../components/header";
import { AgentsTable } from "./components/agents-table";

export const metadata: Metadata = {
  title: "Agents",
  description: "Manage AI agents for your organization",
};

export default function AgentsPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header breadcrumbs={[{ label: "Agents" }]} />
      <FeatureFlagged flag="agents">
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6">
          <AgentsTable />
        </div>
      </FeatureFlagged>
    </div>
  );
}
