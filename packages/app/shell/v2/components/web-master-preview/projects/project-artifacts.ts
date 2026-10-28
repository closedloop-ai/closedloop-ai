import { branchToGenericArtifact } from "@repo/app/branches/components/prototype-preview/generic-adapter"; // Cross-slice: preview shell hosts the Branches preview (ISS-12938).
import type { ProjectSummaryRow } from "@repo/app/projects/lib/project-summary-row"; // Cross-slice: project pages render the shipped project list (ISS-12938).
import type { ArtifactListSummaryMetric } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-model";
import {
  ArtifactKind,
  type GenericArtifact,
  genericArtifacts,
} from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import { findWebMasterBranch } from "../../../../../branches/components/prototype-preview/branch-route-resolution"; // Cross-slice: preview shell hosts the Branches preview (ISS-12938).
import {
  middle,
  summaryDefinition,
} from "../components/specialized-artifact-list-config";
import { findProject, webMasterProjects } from "./project-model";

export const projectSummaryMetricDefinitions = [
  summaryDefinition(
    "project-completion",
    "Project completion",
    "Share of the project's child tasks currently marked Done.",
    "Done child tasks divided by all child tasks in the project.",
    7,
    MetricPolarity.HigherIsBetter
  ),
  summaryDefinition(
    "artifact-count",
    "Artifacts",
    "Artifacts currently included in this project view.",
    "Counted from project artifacts matching the active collection filters.",
    12
  ),
  summaryDefinition(
    "estimated-total-cost",
    "Est. total",
    "Estimated total token cost for the current project view.",
    "Adds attributed creation and revision session costs for matching artifacts.",
    8,
    MetricPolarity.LowerIsBetter
  ),
  summaryDefinition(
    "median-token-cost",
    "Median token cost",
    "Typical token cost per matching project artifact.",
    "Uses the median attributed cost to reduce the effect of outliers.",
    -6,
    MetricPolarity.LowerIsBetter
  ),
  // Metric #5 carries no comparison of its own yet, so its delta is a flat 0
  // under the Neutral default rather than a movement the metric cannot measure.
  summaryDefinition(
    "metric-five",
    "Metric #5",
    "Reserved for a future project metric.",
    "Requires a dedicated calculation specification before implementation.",
    0
  ),
] as const satisfies readonly Omit<ArtifactListSummaryMetric, "value">[];

export function artifactsForProject(
  project: ProjectSummaryRow
): GenericArtifact[] {
  // An absent count is an unknown collection, not a populated one: falling into
  // the compute path against an empty artifact set renders "0%"/"0"/"$0.00" as
  // if they had been measured.
  if (!project.childTaskCount) {
    return [];
  }
  const projectArtifactCandidates = genericArtifacts.filter(
    (artifact) => artifact.kind !== ArtifactKind.Session
  );
  const projectIndex = Math.max(
    0,
    webMasterProjects.findIndex((candidate) => candidate.id === project.id)
  );
  const artifactCount = Math.min(
    projectArtifactCandidates.length,
    Math.max(3, project.childTaskCount)
  );
  const projectArtifacts = Array.from({ length: artifactCount }, (_, index) => {
    const source =
      projectArtifactCandidates[
        (projectIndex + index) % projectArtifactCandidates.length
      ];
    return {
      ...source,
      project: project.name,
    };
  });
  return applyProjectArtifactLineage(project, projectArtifacts);
}

// Traceability: this fixture is the prototype evidence for ISS-6560 PJV-01,
// PJV-02, PJV-04, and PJV-11. Keep its four-level mixed-artifact lineage and
// root structure aligned with those canonical acceptance criteria.
const projectLineageFixtures = [
  {
    kind: ArtifactKind.Document,
    parentIndex: null,
    slug: "DOC-595",
    title: "Project screens v2",
  },
  {
    kind: ArtifactKind.Issue,
    parentIndex: 0,
    slug: "ISS-6560",
    title: "Add parent and child artifacts to project views",
  },
  {
    kind: ArtifactKind.Issue,
    parentIndex: 1,
    slug: "ISS-6572",
    title: "Support nested sub-issues in project lists",
  },
  // A Branch artifact's destination is the Branches surface, which resolves its
  // own `BranchRow` fixture. So a project branch names a branch that fixture
  // actually carries, rather than an invented one that route could never look
  // up; `projectArtifactRouteKey` turns the branch name into that row's key so
  // the identifier column keeps a human reference instead of a raw fixture id.
  {
    kind: ArtifactKind.Branch,
    parentIndex: 2,
    slug: "BR-1284",
    title: "agent/synthetic-seed-generator",
  },
  {
    kind: ArtifactKind.Document,
    parentIndex: null,
    slug: "DOC-602",
    title: "Unified status rollout",
  },
  {
    kind: ArtifactKind.Issue,
    parentIndex: 4,
    slug: "ISS-6594",
    title: "Apply normalized statuses across artifact types",
  },
  {
    kind: ArtifactKind.Branch,
    parentIndex: 5,
    slug: "BR-1281",
    title: "agent/inbox-realtime-v2",
  },
] as const;

function applyProjectArtifactLineage(
  project: ProjectSummaryRow,
  artifacts: readonly GenericArtifact[]
): GenericArtifact[] {
  return artifacts.map((artifact, index) => {
    const fixture = projectLineageFixtures[index];
    if (!fixture) {
      return { ...artifact, parentArtifactId: null };
    }
    const parentFixture =
      fixture.parentIndex === null
        ? null
        : projectLineageFixtures[fixture.parentIndex];
    const id = projectArtifactId(project, fixture.slug);
    return {
      ...lineageBaseArtifact(fixture, artifact),
      // A lineage-replaced artifact owns its identity. Keeping the source row's
      // id let an edit made on the project's DOC-595, now that its handoff link
      // actually lands, write to the unrelated Documents row that id belongs to.
      id,
      kind: fixture.kind,
      parentArtifactId: parentFixture
        ? projectArtifactId(project, parentFixture.slug)
        : null,
      project: project.name,
      slug: fixture.slug,
      title: projectArtifactTitles.get(id) ?? fixture.title,
    };
  });
}

function projectArtifactId(project: ProjectSummaryRow, slug: string): string {
  return `${project.id}-${slug}`;
}

export function projectArtifactHref(
  project: ProjectSummaryRow,
  artifact: GenericArtifact
): string {
  const params = new URLSearchParams({
    project: project.id,
    source: "projects",
    tab: artifact.kind === ArtifactKind.Session ? "details" : "artifact",
  });
  return `/p/web-master/${projectArtifactRouteSegment(artifact)}/${encodeURIComponent(projectArtifactRouteKey(artifact))}?${params.toString()}`;
}

/** The route segment `projectArtifactHref` sends this artifact's kind to. */
export function projectArtifactRouteSegment(artifact: GenericArtifact): string {
  return artifactRouteSegment[artifact.kind];
}

/**
 * The key the destination route resolves this artifact by.
 *
 * Every kind but Branch is identified by its slug in its own collection. The
 * Branches surface keys its rows by `BranchRow.id`, which is a fixture key and
 * not something the identifier column should ever show, so the branch name the
 * artifact already carries as its title is what maps onto it.
 */
export function projectArtifactRouteKey(artifact: GenericArtifact): string {
  if (artifact.kind === ArtifactKind.Branch) {
    return findWebMasterBranch(artifact.title)?.id ?? artifact.slug;
  }
  return artifact.slug;
}

/**
 * The project-scoped artifact behind a handoff link. Project artifacts are
 * project-scoped copies with replacement lineage identities, so a destination
 * route cannot find them in its own fixture set; this is the lookup that lets
 * it resolve one from the `project` the link carries.
 */
export function findProjectArtifact(
  projectId: string | null | undefined,
  routeKey: string | null | undefined
): GenericArtifact | undefined {
  if (!(projectId && routeKey)) {
    return undefined;
  }
  const project = findProject(projectId);
  if (!project) {
    return undefined;
  }
  return artifactsForProject(project).find(
    (artifact) => artifact.id === routeKey || artifact.slug === routeKey
  );
}

export function buildProjectSummaryMetrics(
  project: ProjectSummaryRow,
  artifacts: readonly GenericArtifact[]
): ArtifactListSummaryMetric[] {
  if (!project.childTaskCount) {
    return projectSummaryMetricDefinitions.map((definition) => ({
      ...definition,
      value: "—",
    }));
  }
  const totalCost = artifacts.reduce(
    (total, artifact) => total + artifact.aiSpend,
    0
  );
  const values = [
    `${project.completionPercentage ?? 0}%`,
    String(artifacts.length),
    `$${totalCost.toLocaleString(undefined, {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
    })}`,
    `$${middle(artifacts.map((artifact) => artifact.aiSpend)).toFixed(2)}`,
    "—",
  ];
  return projectSummaryMetricDefinitions.map((definition, index) => ({
    ...definition,
    value: values[index] ?? "0",
  }));
}

const artifactRouteSegment: Record<ArtifactKind, string> = {
  [ArtifactKind.Agent]: "agents",
  [ArtifactKind.Branch]: "branches",
  [ArtifactKind.Document]: "documents",
  [ArtifactKind.Deployment]: "deployments",
  [ArtifactKind.Issue]: "issues",
  [ArtifactKind.Prototype]: "prototypes",
  [ArtifactKind.Session]: "sessions",
};

/**
 * The record a lineage fixture's own destination would show for it.
 *
 * A Branch artifact's detail view is the Branches surface rendering its own
 * `BranchRow`, so taking status, owner, tags and the rest from the rotating
 * `GenericArtifact` this copy was cut from made the project row contradict the
 * detail its link now reaches: sprint-0810 showed BR-1284 as Triage owned by
 * Sam Chen while `br_1284` is Review owned by Alex Rivera, and each project
 * disagreed differently. `branchToGenericArtifact` is the converter the
 * Branches surface already owns, so every field stays derived from the row
 * instead of being a hand-written list that goes stale on the next field.
 */
function lineageBaseArtifact(
  fixture: (typeof projectLineageFixtures)[number],
  source: GenericArtifact
): GenericArtifact {
  if (fixture.kind !== ArtifactKind.Branch) {
    return source;
  }
  const row = findWebMasterBranch(fixture.title);
  return row ? branchToGenericArtifact(row) : source;
}

/**
 * Renames made on project-scoped artifacts, keyed by project artifact id.
 *
 * Bounded to the finite project x lineage-fixture set: `setProjectArtifactTitle`
 * refuses any id outside it.
 */
const projectArtifactTitles = new Map<string, string>();

/**
 * Persist a rename made on a project-scoped artifact.
 *
 * A project artifact is a project-scoped copy, so it is not in the destination
 * collection's editable state and that collection's own rename cannot hold it —
 * the write produces a new collection, the route restore reruns, and the
 * resolver loads the fixture's original title straight back over the edit.
 * Recording it on the fixture is what makes the rename survive, and keeps it
 * visible on the project collection the reader came from.
 */
export function setProjectArtifactTitle(
  artifact: GenericArtifact,
  title: string
): void {
  if (!isProjectArtifactId(artifact.id)) {
    return;
  }
  projectArtifactTitles.set(artifact.id, title);
}

function isProjectArtifactId(id: string): boolean {
  return webMasterProjects.some((project) =>
    projectLineageFixtures.some(
      (fixture) => projectArtifactId(project, fixture.slug) === id
    )
  );
}
