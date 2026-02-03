import type { Metadata } from "next";
import { Header } from "./components/header";
import { RecentWorkstreamsGrid } from "./components/recent-workstreams-grid";

const title = "ClosedLoop.ai";
const description = "Welcome to ClosedLoop.ai.";

export const metadata: Metadata = {
  title,
  description,
};

export default async function App() {
  return (
    <>
      <Header page="Dashboard" pages={["Home"]} />
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <RecentWorkstreamsGrid />
        <div className="min-h-screen flex-1 rounded-xl bg-muted/50 md:min-h-min" />
      </div>
    </>
  );
}
