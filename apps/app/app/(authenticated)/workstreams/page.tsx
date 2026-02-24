import { Header } from "@/app/(authenticated)/components/header";
import { WorkstreamsList } from "./components/workstreams-list";

export default function WorkstreamsPage() {
  return (
    <>
      <Header page="Workstreams" pages={["Workstreams"]} />
      <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 pt-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-bold text-2xl">Workstreams</h1>
            <p className="text-muted-foreground">
              Manage your feature deliveries, bug fixes, and technical work
            </p>
          </div>
        </div>
        <WorkstreamsList />
      </main>
    </>
  );
}
