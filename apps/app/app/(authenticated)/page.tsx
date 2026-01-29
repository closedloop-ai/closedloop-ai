import { auth } from "@repo/auth/server";
import type { Metadata } from "next";
import dynamic from "next/dynamic";
import { env } from "@/env";
import { AvatarStack } from "./components/avatar-stack";
import { Cursors } from "./components/cursors";
import { Header } from "./components/header";
import { RecentWorkstreamsGrid } from "./components/recent-workstreams-grid";

const title = "ClosedLoop.ai";
const description = "Welcome to ClosedLoop.ai.";

const CollaborationProvider = dynamic(() =>
  import("./components/collaboration-provider").then(
    (mod) => mod.CollaborationProvider
  )
);

export const metadata: Metadata = {
  title,
  description,
};

export default async function App() {
  const { orgId } = await auth();

  return (
    <>
      <Header page="Dashboard" pages={["Home"]}>
        {!!env.LIVEBLOCKS_SECRET && !!orgId && (
          <CollaborationProvider orgId={orgId}>
            <AvatarStack />
            <Cursors />
          </CollaborationProvider>
        )}
      </Header>
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <RecentWorkstreamsGrid />
        <div className="min-h-[100vh] flex-1 rounded-xl bg-muted/50 md:min-h-min" />
      </div>
    </>
  );
}
