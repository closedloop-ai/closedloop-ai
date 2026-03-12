"use client";

import {
  type ArtifactType,
  getRoutePrefixForType,
} from "@repo/api/src/types/artifact";
import type {
  ArtifactSearchResult,
  IssueSearchResult,
  ProjectSearchResult,
  WorkstreamSearchResult,
} from "@repo/api/src/types/search";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { Loader2Icon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ArtifactStatusBadge,
  IssuePriorityBadge,
  IssueStatusBadge,
  WorkstreamStateBadge,
} from "@/components/status-badge";
import { useGlobalSearch } from "@/hooks/queries/use-search";
import { formatDate } from "@/lib/date-utils";
import {
  ARTIFACT_TYPE_LABELS,
  PROJECT_STATUS_LABELS,
} from "@/lib/project-constants";

export function SearchResults() {
  const searchParams = useSearchParams();
  const query = searchParams.get("q") ?? "";

  const { data, isLoading } = useGlobalSearch(query);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const totalResults = data
    ? data.artifacts.length +
      data.issues.length +
      data.workstreams.length +
      data.projects.length
    : 0;

  return (
    <>
      <div className="mb-2">
        <p className="text-muted-foreground">
          {`${totalResults} result${totalResults !== 1 ? "s" : ""} for "${query}"`}
        </p>
      </div>

      {totalResults === 0 && (
        <div className="py-8 text-center text-muted-foreground">
          No results found matching your search.
        </div>
      )}

      {data && data.artifacts.length > 0 && (
        <ArtifactsSection artifacts={data.artifacts} />
      )}

      {data && data.issues.length > 0 && <IssuesSection issues={data.issues} />}

      {data && data.workstreams.length > 0 && (
        <WorkstreamsSection workstreams={data.workstreams} />
      )}

      {data && data.projects.length > 0 && (
        <ProjectsSection projects={data.projects} />
      )}
    </>
  );
}

function SectionHeader({
  title,
  count,
}: Readonly<{ title: string; count: number }>) {
  return (
    <h2 className="mt-6 mb-2 font-semibold text-lg">
      {title}{" "}
      <span className="font-normal text-muted-foreground text-sm">
        ({count})
      </span>
    </h2>
  );
}

function TitleCell({
  href,
  children,
}: Readonly<{ href: string | null; children: React.ReactNode }>) {
  if (href) {
    return (
      <Link className="font-medium text-foreground hover:underline" href={href}>
        {children}
      </Link>
    );
  }
  return <span className="font-medium">{children}</span>;
}

function ArtifactsSection({
  artifacts,
}: Readonly<{ artifacts: ArtifactSearchResult[] }>) {
  return (
    <section>
      <SectionHeader count={artifacts.length} title="Artifacts" />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Project</TableHead>
            <TableHead>Workstream</TableHead>
            <TableHead>Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {artifacts.map((artifact) => {
            const routePrefix = getRoutePrefixForType(artifact.type);
            const href = routePrefix
              ? `/${routePrefix}/${artifact.slug}`
              : null;

            return (
              <TableRow key={artifact.id}>
                <TableCell>
                  <TitleCell href={href}>{artifact.title}</TitleCell>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {ARTIFACT_TYPE_LABELS[artifact.type as ArtifactType] ??
                    artifact.type}
                </TableCell>
                <TableCell>
                  <ArtifactStatusBadge status={artifact.status} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {artifact.projectName ?? "-"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {artifact.workstreamTitle ?? "-"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDate(artifact.updatedAt)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

function IssuesSection({ issues }: Readonly<{ issues: IssueSearchResult[] }>) {
  return (
    <section>
      <SectionHeader count={issues.length} title="Features" />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Priority</TableHead>
            <TableHead>Project</TableHead>
            <TableHead>Workstream</TableHead>
            <TableHead>Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {issues.map((issue) => (
            <TableRow key={issue.id}>
              <TableCell>
                <TitleCell href={`/issues/${issue.slug}`}>
                  {issue.title}
                </TitleCell>
              </TableCell>
              <TableCell>
                <IssueStatusBadge status={issue.status} />
              </TableCell>
              <TableCell>
                <IssuePriorityBadge priority={issue.priority} />
              </TableCell>
              <TableCell className="text-muted-foreground">
                {issue.projectName ?? "-"}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {issue.workstreamTitle ?? "-"}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatDate(issue.updatedAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

function WorkstreamsSection({
  workstreams,
}: Readonly<{ workstreams: WorkstreamSearchResult[] }>) {
  return (
    <section>
      <SectionHeader count={workstreams.length} title="Workstreams" />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Project</TableHead>
            <TableHead>Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {workstreams.map((ws) => (
            <TableRow key={ws.id}>
              <TableCell>
                <TitleCell href={`/workstreams/${ws.id}`}>{ws.title}</TitleCell>
              </TableCell>
              <TableCell>
                <WorkstreamStateBadge state={ws.state} />
              </TableCell>
              <TableCell className="text-muted-foreground">
                {ws.projectName}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatDate(ws.updatedAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

function ProjectsSection({
  projects,
}: Readonly<{ projects: ProjectSearchResult[] }>) {
  return (
    <section>
      <SectionHeader count={projects.length} title="Projects" />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Priority</TableHead>
            <TableHead>Team</TableHead>
            <TableHead>Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {projects.map((project) => {
            const href = project.teamId
              ? `/teams/${project.teamId}/projects/${project.id}`
              : null;

            return (
              <TableRow key={project.id}>
                <TableCell>
                  <TitleCell href={href}>{project.name}</TitleCell>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {PROJECT_STATUS_LABELS[project.status] ?? project.status}
                </TableCell>
                <TableCell>
                  <IssuePriorityBadge priority={project.priority} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {project.teamName ?? "-"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDate(project.updatedAt)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}
