import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "../components/header";
import { LoopsTable } from "./components/loops-table";

export const metadata: Metadata = {
  title: "Loops",
  description: "View all AI agent execution loops",
};

export default function LoopsPage() {
  return (
    <>
      <Header breadcrumbs={[{ label: "Loops" }]} />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="font-bold text-2xl">Loops</h1>
            <p className="text-muted-foreground">
              Track AI agent executions across your organization
            </p>
          </div>
          <Link
            className="inline-flex h-9 items-center justify-center rounded-md border border-input-border bg-background px-4 font-medium text-sm hover:bg-accent hover:text-accent-foreground"
            href="/loops/usage"
          >
            Usage
          </Link>
        </div>
        <LoopsTable />
      </div>
    </>
  );
}
