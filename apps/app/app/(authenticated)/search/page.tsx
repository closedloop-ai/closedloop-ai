import { auth } from "@repo/auth/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { searchWorkstreams } from "@/app/actions/workstreams";
import { WorkstreamStateBadge } from "@/components/status-badge";
import { Header } from "../components/header";

type SearchPageProperties = {
  searchParams: Promise<{
    q: string;
  }>;
};

export const generateMetadata = async ({
  searchParams,
}: SearchPageProperties) => {
  const { q } = await searchParams;

  return {
    title: `${q} - Search results`,
    description: `Search results for ${q}`,
  };
};

const SearchPage = async ({ searchParams }: SearchPageProperties) => {
  const { q } = await searchParams;
  const { orgId } = await auth();

  if (!orgId) {
    notFound();
  }

  if (!q) {
    redirect("/");
  }

  const result = await searchWorkstreams(q);
  const workstreams = result.success ? result.data : [];

  return (
    <>
      <Header page="Search" pages={["Results"]} />
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <div className="mb-4">
          <p className="text-muted-foreground">
            {workstreams.length} result{workstreams.length !== 1 ? "s" : ""} for
            &quot;{q}&quot;
          </p>
        </div>
        <div className="grid auto-rows-min gap-4 md:grid-cols-3">
          {workstreams.map((ws) => (
            <Link
              className="flex aspect-video flex-col justify-between rounded-xl bg-muted/50 p-4 transition-colors hover:bg-muted/70"
              href={`/workstreams/${ws.id}`}
              key={ws.id}
            >
              <div>
                <h3 className="font-medium">{ws.title}</h3>
                <p className="text-muted-foreground text-sm">
                  {ws.project.name}
                </p>
              </div>
              <WorkstreamStateBadge state={ws.state} />
            </Link>
          ))}
        </div>
        {workstreams.length === 0 && (
          <div className="py-8 text-center text-muted-foreground">
            No workstreams found matching your search.
          </div>
        )}
      </div>
    </>
  );
};

export default SearchPage;
