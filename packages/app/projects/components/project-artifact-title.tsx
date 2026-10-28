"use client";

import { ArtifactType } from "@repo/api/src/types/artifact";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table-card";
import { Link } from "@repo/navigation/link";
import { useOrgPath } from "@repo/navigation/use-org-path";
import type { ReactNode } from "react";
import {
  projectArtifactHref,
  type projectArtifactParents,
} from "../lib/project-artifact-list-helpers";
import { projectArtifactRoute } from "../lib/project-artifact-navigation";

/** Renders the established project title link, with an optional composed hierarchy lead. */
export function ProjectArtifactTitle({
  title,
  href,
  external = false,
  lead,
}: {
  title: string;
  href?: string;
  external?: boolean;
  lead?: ReactNode;
}) {
  const className = lead
    ? "block min-w-0 max-w-full text-sm"
    : "block min-w-0 truncate text-sm";
  if (href && external) {
    return (
      <a
        className={className}
        href={href}
        rel="noopener noreferrer"
        target="_blank"
      >
        {lead ?? title}
      </a>
    );
  }
  if (href) {
    return (
      <Link className={className} href={href}>
        {lead ?? title}
      </Link>
    );
  }
  return <span className={className}>{lead ?? title}</span>;
}

export function ProjectArtifactParents({
  parents,
}: {
  parents: ReturnType<typeof projectArtifactParents>;
}) {
  const orgPath = useOrgPath();
  if (parents.length === 0) {
    return <GridEmptyValue />;
  }
  return (
    <span className="flex min-w-0 gap-2">
      {parents.map((parent) => {
        const route = projectArtifactRoute(parent);
        return (
          <ProjectArtifactTitle
            external={parent.type === ArtifactType.Deployment}
            href={projectArtifactHref(parent.type, route, orgPath)}
            key={parent.id}
            title={parent.name}
          />
        );
      })}
    </span>
  );
}
