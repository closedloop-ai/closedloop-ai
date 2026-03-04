import type { Metadata } from "next";
import { DashboardStatsGrid } from "./components/dashboard-stats-grid";
import { Header } from "./components/header";
import { InProgressWorkstreamsTable } from "./components/in-progress-workstreams-table";

const title = "ClosedLoop.ai";
const description = "Welcome to ClosedLoop.ai.";

export const metadata: Metadata = {
  title,
  description,
};

export default async function App() {
  return (
    <>
      <Header
        breadcrumbs={[{ label: "Home", href: "/" }, { label: "Dashboard" }]}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 pt-0">
        <div className="space-y-8">
          <section>
            <h2 className="mb-4 font-bold text-2xl">Overview</h2>
            <DashboardStatsGrid />
          </section>
          <section>
            <h2 className="mb-4 font-bold text-2xl">Active Workstreams</h2>
            <InProgressWorkstreamsTable />
          </section>
        </div>
      </div>
    </>
  );
}
