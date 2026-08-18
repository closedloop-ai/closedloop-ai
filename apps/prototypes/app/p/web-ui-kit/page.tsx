import { Button } from "@repo/design-system/components/ui/button";
import { Plus, Settings2 } from "lucide-react";
import { AppShell } from "./components/app-shell";
import { ProjectsTable } from "./components/projects-table";

const WebUiKitPrototypePage = () => (
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
      <ProjectsTable />
    </div>
  </AppShell>
);

export default WebUiKitPrototypePage;
