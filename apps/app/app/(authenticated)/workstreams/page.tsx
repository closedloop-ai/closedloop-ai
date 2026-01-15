import { Header } from "@/app/(authenticated)/components/header";
import { getWorkstreams } from "@/app/actions/workstreams";
import { WorkstreamsList } from "./components/workstreams-list";

export default async function WorkstreamsPage() {
  const result = await getWorkstreams();

  return (
    <>
      <Header page="Workstreams" pages={["Workstreams"]} />
      <main className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-bold text-2xl">Workstreams</h1>
            <p className="text-muted-foreground">
              Manage your feature deliveries, bug fixes, and technical work
            </p>
          </div>
        </div>

        {result.success ? (
          <WorkstreamsList workstreams={result.data} />
        ) : (
          <div className="rounded-md border border-destructive/20 bg-destructive/10 p-4 text-destructive">
            {result.error}
          </div>
        )}
      </main>
    </>
  );
}
