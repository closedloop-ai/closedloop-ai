"use client";

import {
  DocumentType,
  getRoutePrefixForType,
} from "@repo/api/src/types/document";
import type {
  DocumentSearchResult,
  ProjectSearchResult,
} from "@repo/api/src/types/search";
import {
  DOCUMENT_TYPE_LABELS,
  PROJECT_STATUS_LABELS,
} from "@repo/app/projects/lib/project-constants";
import { useGlobalSearch } from "@repo/app/search/hooks/use-search";
import {
  DocumentStatusBadge,
  FeaturePriorityBadge,
  FeatureStatusBadge,
} from "@repo/app/shared/components/status-badge";
import { formatDate } from "@repo/app/shared/lib/date-utils";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { Link } from "@repo/navigation/link";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { Loader2Icon, XIcon } from "lucide-react";
import { useOrgSlug } from "@/hooks/use-org-slug";

export function SearchResults() {
  const orgSlug = useOrgSlug();
  const navigation = useNavigation();
  const searchParams = useSearchParamsValue();
  const query = searchParams.get("q") ?? "";
  const tagId = searchParams.get("tagId") ?? "";

  const { data, isLoading } = useGlobalSearch(tagId ? { tagId } : { query });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const totalResults = data ? data.documents.length + data.projects.length : 0;

  const notFeatures = data?.documents.filter(
    (d) => d.type !== DocumentType.Feature
  );
  const features = data?.documents.filter(
    (d) => d.type === DocumentType.Feature
  );

  const isTagSearch = !!data?.tagId;
  const handleClearSearch = () => {
    navigation.replace(`/${orgSlug}/my-tasks`, { scroll: false });
  };

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground">
          {isTagSearch
            ? `${totalResults} result${totalResults === 1 ? "" : "s"} tagged with "${data?.tagName ?? ""}"`
            : `${totalResults} result${totalResults === 1 ? "" : "s"} for "${query}"`}
        </p>
        <Button
          aria-label="Clear search"
          onClick={handleClearSearch}
          size="sm"
          type="button"
          variant="outline"
        >
          <XIcon className="size-3.5" />
          Clear
        </Button>
      </div>

      {totalResults === 0 && (
        <div className="py-8 text-center text-muted-foreground">
          {isTagSearch
            ? "No documents found with this tag."
            : "No results found matching your search."}
        </div>
      )}

      {!!notFeatures?.length && <ArtifactsSection artifacts={notFeatures} />}

      {!!features?.length && <FeaturesSection features={features} />}

      {!!data?.projects.length && <ProjectsSection projects={data.projects} />}
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
}: Readonly<{ artifacts: DocumentSearchResult[] }>) {
  const orgSlug = useOrgSlug();
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
            <TableHead>Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {artifacts.map((artifact) => {
            const routePrefix = getRoutePrefixForType(artifact.type);
            const href = routePrefix
              ? `/${orgSlug}/${routePrefix}/${artifact.slug}`
              : null;

            return (
              <TableRow key={artifact.id}>
                <TableCell>
                  <TitleCell href={href}>{artifact.title}</TitleCell>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {DOCUMENT_TYPE_LABELS[artifact.type as DocumentType] ??
                    artifact.type}
                </TableCell>
                <TableCell>
                  <DocumentStatusBadge status={artifact.status} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {artifact.projectName ?? "-"}
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

function FeaturesSection({
  features,
}: Readonly<{ features: DocumentSearchResult[] }>) {
  const orgSlug = useOrgSlug();
  return (
    <section>
      <SectionHeader count={features.length} title="Features" />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Priority</TableHead>
            <TableHead>Project</TableHead>
            <TableHead>Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {features.map((feature) => (
            <TableRow key={feature.id}>
              <TableCell>
                <TitleCell href={`/${orgSlug}/features/${feature.slug}`}>
                  {feature.title}
                </TitleCell>
              </TableCell>
              <TableCell>
                <FeatureStatusBadge status={feature.status} />
              </TableCell>
              <TableCell>
                {feature.priority && (
                  <FeaturePriorityBadge priority={feature.priority} />
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {feature.projectName ?? "-"}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatDate(feature.updatedAt)}
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
  const orgSlug = useOrgSlug();
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
              ? `/${orgSlug}/teams/${project.teamId}/projects/${project.id}`
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
                  {project.priority && (
                    <FeaturePriorityBadge priority={project.priority} />
                  )}
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
