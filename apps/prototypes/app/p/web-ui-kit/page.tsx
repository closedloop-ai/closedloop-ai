"use client";

import { ProjectsTable } from "@repo/app/projects/components/projects-table";
import { Button } from "@repo/design-system/components/ui/button";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { Plus, Settings2 } from "lucide-react";
import { useState } from "react";
import { AppShell } from "./components/app-shell";
import { projects } from "./mock";

const WebUiKitPrototypePage = () => {
  const [navigation] = useState(() =>
    createMemoryNavigation({ initialPath: "/p/web-ui-kit" })
  );
  return (
    <AppShell
      actions={
        <Button size="sm">
          <Plus />
          Add Project
        </Button>
      }
      breadcrumbs={[
        { label: "Home" },
        { label: "ClosedLoop" },
        { label: "Projects", isCurrent: true },
      ]}
    >
      <div className="flex min-w-fit items-center justify-between border-border border-b px-4 pt-4 pb-2">
        <h1 className="font-semibold text-xl">Projects</h1>
        <Button size="sm" variant="outline">
          <Settings2 />
          View
        </Button>
      </div>
      <div className="flex-1 overflow-auto">
        <NavigationProvider adapter={navigation.adapter}>
          <ProjectsTable rows={projects} />
        </NavigationProvider>
      </div>
    </AppShell>
  );
};

export default WebUiKitPrototypePage;
