import type { Metadata } from "next";
import { Header } from "../../components/header";
import { AgentsGroupedListContainer } from "./components/agents-grouped-list-container";

export const metadata: Metadata = {
  title: "Agents",
  description: "Manage AI agents for your organization",
};

export default function AgentsPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header breadcrumbs={[{ label: "Agents" }]} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <AgentsGroupedListContainer />
      </div>
    </div>
  );
}
