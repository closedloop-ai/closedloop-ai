/**
 * Non-empty-org guard for the seed CLI.
 *
 * Queries the seed-owned org surface and returns
 * a list of conflict descriptions. The caller decides whether to abort or
 * proceed (e.g. when SEED_FORCE_OVERWRITE=1 is set).
 *
 * Extracted from seed.ts so it can be unit-tested without mocking process.exit.
 */

import type { PrismaClient } from "../../generated/client";
import { deterministicUuid } from "./helpers";

const SCALED_SEED_PROJECT_SLUG_PATTERN = /^scaled-seed-project-(\d+)$/;
const SEED_OWNED_SAMPLE_LIMIT = 500;
const SEED_ARTIFACT_SLUG_PATTERN =
  /^(seed-doc-|seed-feature-|seed-template-|scaled-seed-document-|seed-branch-|seed-deployment-|seed-session-)/;
const SEED_COMMENT_TEXT_PATTERN =
  /^(Seed |Scaled seed comment |Initial feedback on this document\.|Follow-up: looks good after review\.|Liveblocks collaborative comment\.|Resolved the concern mentioned above\.|GitHub PR review comment )/;
const SEED_CUSTOM_FIELD_NAMES = new Set([
  "Notes",
  "Story Points",
  "Team",
  "Labels",
  "Target Date",
  "Reviewers",
]);

export const SeedOrgPreflightStatus = {
  Clean: "clean",
  SeedOwned: "seed-owned",
  Conflicted: "conflicted",
} as const;
export type SeedOrgPreflightStatus =
  (typeof SeedOrgPreflightStatus)[keyof typeof SeedOrgPreflightStatus];

/**
 * Result from {@link detectOrgConflicts}.
 *
 * `conflicts` is an array of human-readable descriptions for each model that
 * already has rows for the given organization.  An empty array means the org
 * has no pre-existing seed data and seeding can proceed safely.
 */
export type OrgConflictResult = {
  conflicts: string[];
  seedOwnedRows: string[];
  status: SeedOrgPreflightStatus;
};

type SeedOwnedRow = {
  id: string;
  slug?: string | null;
};

type SeedOwnedNamedRow = {
  id: string;
  name?: string | null;
};

type SeedOwnedTextRow = {
  id: string;
  plainText?: string | null;
};

type SeedOwnedLoopRow = {
  id: string;
  prompt?: string | null;
};

type SeedOwnedEvaluationRow = {
  id: string;
  reportId?: string | null;
};

function formatRowCount(label: string, count: number): string {
  return `${label} (${count} ${count === 1 ? "row" : "rows"})`;
}

/**
 * Queries seed-owned org rows and returns
 * any conflicts found for `organizationId`.
 *
 * Queries run in parallel via Promise.all.
 */
export async function detectOrgConflicts(
  prisma: PrismaClient,
  organizationId: string
): Promise<OrgConflictResult> {
  const [
    existingGitHubInstallation,
    existingLinearIntegration,
    existingSlackIntegration,
    projectCount,
    teamCount,
    projects,
    teams,
    artifactCount,
    artifacts,
    loopCount,
    loops,
    commentCount,
    comments,
    customFieldCount,
    customFields,
    artifactEvaluationCount,
    artifactEvaluations,
  ] = await Promise.all([
    prisma.gitHubInstallation.findUnique({
      where: { organizationId },
      select: { id: true },
    }),
    prisma.linearIntegration.findUnique({
      where: { organizationId },
      select: { id: true },
    }),
    prisma.slackIntegration.findUnique({
      where: { organizationId },
      select: { id: true },
    }),
    prisma.project.count({ where: { organizationId } }),
    prisma.team.count({ where: { organizationId } }),
    prisma.project.findMany({
      where: { organizationId },
      select: { id: true, slug: true },
    }),
    prisma.team.findMany({
      where: { organizationId },
      select: { id: true, slug: true },
    }),
    prisma.artifact.count({ where: { organizationId } }),
    prisma.artifact.findMany({
      where: { organizationId },
      select: { id: true, slug: true },
      take: SEED_OWNED_SAMPLE_LIMIT,
    }),
    prisma.loop.count({ where: { organizationId } }),
    prisma.loop.findMany({
      where: { organizationId },
      select: { id: true, prompt: true },
      take: SEED_OWNED_SAMPLE_LIMIT,
    }),
    prisma.comment.count({
      where: { thread: { organizationId } },
    }),
    prisma.comment.findMany({
      where: { thread: { organizationId } },
      select: { id: true, plainText: true },
      take: SEED_OWNED_SAMPLE_LIMIT,
    }),
    prisma.customField.count({ where: { organizationId } }),
    prisma.customField.findMany({
      where: { organizationId },
      select: { id: true, name: true },
    }),
    prisma.artifactEvaluation.count({ where: { organizationId } }),
    prisma.artifactEvaluation.findMany({
      where: { organizationId },
      select: { id: true, reportId: true },
    }),
  ]);

  const conflicts: string[] = [];
  const seedOwnedRows: string[] = [];

  recordOnePerOrgRow({
    existing: existingGitHubInstallation,
    expectedId: deterministicUuid(`github-installation:${organizationId}:seed`),
    seedOwnedRows,
    conflicts,
    seedOwnedLabel: "GitHubInstallation (seed-owned)",
    conflictLabel: "GitHubInstallation (one per org)",
  });
  recordOnePerOrgRow({
    existing: existingLinearIntegration,
    expectedId: deterministicUuid(`linear-integration:${organizationId}:seed`),
    seedOwnedRows,
    conflicts,
    seedOwnedLabel: "LinearIntegration (seed-owned)",
    conflictLabel: "LinearIntegration (one per org)",
  });
  recordOnePerOrgRow({
    existing: existingSlackIntegration,
    expectedId: deterministicUuid(`slack-integration:${organizationId}:seed`),
    seedOwnedRows,
    conflicts,
    seedOwnedLabel: "SlackIntegration (seed-owned)",
    conflictLabel: "SlackIntegration (one per org)",
  });
  recordCountedRows({
    label: "Project",
    count: projectCount,
    isSeedOwned: areSeedOwnedProjects(projects, projectCount, organizationId),
    seedOwnedRows,
    conflicts,
  });
  recordCountedRows({
    label: "Team",
    count: teamCount,
    isSeedOwned: areSeedOwnedTeams(teams, teamCount, organizationId),
    seedOwnedRows,
    conflicts,
  });
  recordCountedRows({
    label: "Artifact",
    count: artifactCount,
    isSeedOwned: areSeedOwnedArtifacts(artifacts, artifactCount),
    seedOwnedRows,
    conflicts,
  });
  recordCountedRows({
    label: "Loop",
    count: loopCount,
    isSeedOwned: areSeedOwnedLoops(loops, loopCount),
    seedOwnedRows,
    conflicts,
  });
  recordCountedRows({
    label: "Comment",
    count: commentCount,
    isSeedOwned: areSeedOwnedComments(comments, commentCount),
    seedOwnedRows,
    conflicts,
  });
  recordCountedRows({
    label: "CustomField",
    count: customFieldCount,
    isSeedOwned: areSeedOwnedCustomFields(customFields, customFieldCount),
    seedOwnedRows,
    conflicts,
  });
  recordCountedRows({
    label: "ArtifactEvaluation",
    count: artifactEvaluationCount,
    isSeedOwned: areSeedOwnedArtifactEvaluations(
      artifactEvaluations,
      artifactEvaluationCount
    ),
    seedOwnedRows,
    conflicts,
  });

  let status: SeedOrgPreflightStatus = SeedOrgPreflightStatus.Clean;
  if (conflicts.length > 0) {
    status = SeedOrgPreflightStatus.Conflicted;
  } else if (seedOwnedRows.length > 0) {
    status = SeedOrgPreflightStatus.SeedOwned;
  }

  return { conflicts, seedOwnedRows, status };
}

function recordOnePerOrgRow({
  existing,
  expectedId,
  seedOwnedRows,
  conflicts,
  seedOwnedLabel,
  conflictLabel,
}: {
  existing: { id: string } | null;
  expectedId: string;
  seedOwnedRows: string[];
  conflicts: string[];
  seedOwnedLabel: string;
  conflictLabel: string;
}) {
  if (!existing) {
    return;
  }
  if (existing.id === expectedId) {
    seedOwnedRows.push(seedOwnedLabel);
    return;
  }
  conflicts.push(conflictLabel);
}

function recordCountedRows({
  label,
  count,
  isSeedOwned,
  seedOwnedRows,
  conflicts,
}: {
  label: string;
  count: number;
  isSeedOwned: boolean;
  seedOwnedRows: string[];
  conflicts: string[];
}) {
  if (count === 0) {
    return;
  }
  const description = formatRowCount(label, count);
  if (isSeedOwned) {
    seedOwnedRows.push(description);
    return;
  }
  conflicts.push(description);
}

function areSeedOwnedTeams(
  rows: readonly SeedOwnedRow[],
  count: number,
  organizationId: string
): boolean {
  return (
    rows.length === count &&
    rows.length === 1 &&
    rows[0]?.id === deterministicUuid(`team:${organizationId}:default`) &&
    rows[0]?.slug === "default"
  );
}

function areSeedOwnedProjects(
  rows: readonly SeedOwnedRow[],
  count: number,
  organizationId: string
): boolean {
  return (
    rows.length === count &&
    rows.every((row) => {
      if (!row.slug) {
        return false;
      }
      return row.id === expectedProjectId(row.slug, organizationId);
    })
  );
}

function expectedProjectId(slug: string, organizationId: string): string {
  if (slug === "platform-foundation") {
    return deterministicUuid(`project:${organizationId}:platform-foundation`);
  }
  if (slug === "developer-experience") {
    return deterministicUuid(`project:${organizationId}:developer-experience`);
  }
  const scaledMatch = SCALED_SEED_PROJECT_SLUG_PATTERN.exec(slug);
  if (scaledMatch) {
    return deterministicUuid(
      `project:${organizationId}:scaled-${scaledMatch[1]}`
    );
  }
  return "";
}

function areSeedOwnedArtifacts(
  rows: readonly SeedOwnedRow[],
  count: number
): boolean {
  return (
    rows.length === count &&
    rows.every(
      (row) =>
        Boolean(row.slug) && SEED_ARTIFACT_SLUG_PATTERN.test(row.slug ?? "")
    )
  );
}

function areSeedOwnedLoops(
  rows: readonly SeedOwnedLoopRow[],
  count: number
): boolean {
  return (
    rows.length === count && rows.every((row) => isSeedLoopPrompt(row.prompt))
  );
}

function isSeedLoopPrompt(prompt: string | null | undefined): boolean {
  if (!prompt) {
    return false;
  }
  return (
    prompt.startsWith("Generate an implementation plan") ||
    prompt.startsWith("Execute the approved implementation plan") ||
    prompt.startsWith("Discuss architectural trade-offs") ||
    prompt.startsWith("Evaluate the PRD") ||
    prompt.startsWith("Generate implementation plan for event streaming") ||
    prompt.startsWith("Execute the webhook delivery system") ||
    prompt.startsWith("Discuss design options for the observability") ||
    prompt.startsWith("Execute the billing integration")
  );
}

function areSeedOwnedComments(
  rows: readonly SeedOwnedTextRow[],
  count: number
): boolean {
  return (
    rows.length === count &&
    rows.every((row) => SEED_COMMENT_TEXT_PATTERN.test(row.plainText ?? ""))
  );
}

function areSeedOwnedCustomFields(
  rows: readonly SeedOwnedNamedRow[],
  count: number
): boolean {
  return (
    rows.length === count &&
    rows.every((row) => SEED_CUSTOM_FIELD_NAMES.has(row.name ?? ""))
  );
}

function areSeedOwnedArtifactEvaluations(
  rows: readonly SeedOwnedEvaluationRow[],
  count: number
): boolean {
  return (
    rows.length === count &&
    rows.every((row) => row.reportId?.startsWith("seed-report-") === true)
  );
}
