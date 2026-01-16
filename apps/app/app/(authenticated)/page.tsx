import { auth } from "@repo/auth/server";
import type { Metadata } from "next";
import dynamic from "next/dynamic";
import Link from "next/link";
import { getRecentWorkstreams } from "@/app/actions/workstreams";
import { WorkstreamStateBadge } from "@/components/status-badge";
import { env } from "@/env";
import { AvatarStack } from "./components/avatar-stack";
import { Cursors } from "./components/cursors";
import { Header } from "./components/header";

const title = "Symphony";
const description = "Welcome to Symphony.";

const CollaborationProvider = dynamic(() =>
  import("./components/collaboration-provider").then(
    (mod) => mod.CollaborationProvider
  )
);


export const metadata: Metadata = {
  title,
  description,
};

const App = async () => {
  const result = await getRecentWorkstreams(6);
  const workstreams = result.success ? result.data : [];
  const { orgId } = await auth();

  // Fallback home page when no organization is set up
  if (!orgId) {
    return (
      <>
        <Header page="Home" pages={["Dashboard"]}>
          {null}
        </Header>
        <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
          <div className="rounded-xl border bg-card p-6">
            <h1 className="mb-2 font-bold text-2xl">Welcome to Symphony</h1>
            <p className="mb-4 text-muted-foreground">
              Your app is up and running. Start building something great!
            </p>
            <div className="mt-6 grid auto-rows-min gap-4 md:grid-cols-3">
              {workstreams.length > 0 ? (
                workstreams.map((ws) => (
                  <Link
                    className="flex aspect-video flex-col items-start justify-between rounded-xl bg-muted/50 p-4 transition-colors hover:bg-muted/70"
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
                ))
              ) : (
                <div className="col-span-3 py-8 text-center text-muted-foreground">
                  No workstreams yet. Create one to get started.
                </div>
              )}
            </div>
          </div>
        </div>
      </>
    );
  }

  // Original home page with organization features
  return (
    <>
      <Header page="Dashboard" pages={["Home"]}>
        {!!env.LIVEBLOCKS_SECRET && (
          <CollaborationProvider orgId={orgId}>
            <AvatarStack />
            <Cursors />
          </CollaborationProvider>
        )}
      </Header>
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
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
        <div className="min-h-[100vh] flex-1 rounded-xl bg-muted/50 md:min-h-min" />
      </div>
    </>
  );
};

export default App;
