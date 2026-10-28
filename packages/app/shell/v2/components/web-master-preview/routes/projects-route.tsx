"use client";

import { ProjectList } from "@repo/app/projects/components/project-list"; // Cross-slice: project pages render the shipped project list (ISS-12938).
import type { ProjectSummaryRow } from "@repo/app/projects/lib/project-summary-row"; // Cross-slice: project pages render the shipped project list (ISS-12938).
import { Button } from "@repo/design-system/components/ui/button";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { PageChrome } from "../components/page-chrome";
import {
  projectHref,
  WEB_MASTER_PROJECTS_NOW_MS,
  webMasterProjects,
} from "../projects/project-model";

/**
 * Mock adapter around the portable Projects surface (ISS-10476). Everything
 * this route owns is fixture state: the rows, the frozen clock the "Updated"
 * filter measures against, and the in-memory write a board drop makes. The
 * list, board and table themselves are the same `@repo/app` components the
 * product route mounts.
 */
export function WebMasterProjectsRoute() {
  const [rows, setRows] =
    useState<readonly ProjectSummaryRow[]>(webMasterProjects);

  return (
    <PageChrome
      actions={
        <Button
          disabled
          size="sm"
          title="Project creation is outside this prototype"
          type="button"
        >
          <PlusIcon />
          Add Project
        </Button>
      }
      breadcrumbs={[
        { href: "/p/web-master", label: "Home" },
        { href: "/p/web-master/projects", label: "ClosedLoop" },
        { isCurrent: true, label: "Projects" },
      ]}
    >
      <div className="flex min-w-fit items-center border-border border-b px-4 pt-4 pb-2">
        <h1 className="font-semibold text-xl">Projects</h1>
      </div>
      <ProjectList
        getRowHref={projectHref}
        nowMs={WEB_MASTER_PROJECTS_NOW_MS}
        onProjectGroupChange={(nextRow, previousRow) =>
          setRows((current) =>
            current.map((candidate) =>
              candidate.id === previousRow.id ? nextRow : candidate
            )
          )
        }
        rows={rows}
      />
    </PageChrome>
  );
}
