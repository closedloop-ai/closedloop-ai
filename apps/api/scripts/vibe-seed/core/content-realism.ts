import { ArtifactType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import { ProjectStatus } from "@repo/api/src/types/project";
import type { PrismaClient } from "@repo/database";
import {
  type SeedIntegrityIssue,
  SeedIntegrityIssueCode,
} from "./seed-integrity";

/**
 * ISS-12135 (bugs 15, 22, 23): the checks that tell a seeded org's work apart
 * from generated filler. A finished vibe seed must have product slugs on its
 * projects, work written over weeks by more than one person at more than one
 * priority, enough issues in every live project, and comments from the team
 * rather than from one author.
 */

const PROJECT_SLUG = /^PRO-\d+$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Real work is written over weeks; a seed run takes minutes. */
export const MIN_CREATION_SPAN_DAYS = 14;
/** No one person writes most of a team's documents or comments. */
export const MAX_AUTHOR_SHARE = 0.5;
export const MIN_ISSUES_PER_LIVE_PROJECT = 3;
const EXAMPLE_LIMIT = 5;

export type ContentRealismRows = {
  readonly projects: readonly {
    readonly id: string;
    readonly name: string;
    readonly slug: string | null;
    readonly status: string;
  }[];
  readonly documents: readonly {
    readonly projectId: string | null;
    readonly subtype: string | null;
    readonly createdById: string | null;
    readonly priority: string | null;
    readonly createdAt: Date;
  }[];
  readonly commentAuthorIds: readonly string[];
};

export async function checkContentRealism(
  prisma: PrismaClient,
  organizationId: string
): Promise<SeedIntegrityIssue[]> {
  const [projects, documents, comments] = await Promise.all([
    prisma.project.findMany({
      where: { organizationId },
      select: { id: true, name: true, slug: true, status: true },
    }),
    prisma.artifact.findMany({
      where: {
        organizationId,
        type: ArtifactType.Document,
        subtype: { not: DocumentType.Template },
      },
      select: {
        projectId: true,
        subtype: true,
        createdById: true,
        priority: true,
        createdAt: true,
      },
    }),
    prisma.comment.findMany({
      where: { thread: { organizationId }, deletedAt: null },
      select: { authorId: true },
    }),
  ]);
  return assessContentRealism({
    projects,
    documents,
    commentAuthorIds: comments.map((comment) => comment.authorId),
  });
}

export function assessContentRealism(
  rows: ContentRealismRows
): SeedIntegrityIssue[] {
  return [
    projectsWithoutSlug(rows),
    contentCreatedAtOnce(rows),
    oneAuthor(
      SeedIntegrityIssueCode.OneDocumentAuthor,
      "documents",
      rows.documents.map((document) => document.createdById)
    ),
    oneAuthor(
      SeedIntegrityIssueCode.OneCommentAuthor,
      "comments",
      rows.commentAuthorIds
    ),
    uniformPriority(rows),
    projectsWithFewIssues(rows),
  ].filter((issue): issue is SeedIntegrityIssue => issue !== null);
}

function projectsWithoutSlug(
  rows: ContentRealismRows
): SeedIntegrityIssue | null {
  const missing = rows.projects.filter(
    (project) => !PROJECT_SLUG.test(project.slug ?? "")
  );
  return missing.length === 0
    ? null
    : {
        code: SeedIntegrityIssueCode.ProjectWithoutSlug,
        count: missing.length,
        message: `project(s) without a PRO- id: ${examples(missing.map((project) => `${project.name} (${project.slug})`))}`,
      };
}

function contentCreatedAtOnce(
  rows: ContentRealismRows
): SeedIntegrityIssue | null {
  const times = rows.documents.map((document) => document.createdAt.getTime());
  if (times.length === 0) {
    return null;
  }
  const spanDays = (Math.max(...times) - Math.min(...times)) / DAY_MS;
  return spanDays >= MIN_CREATION_SPAN_DAYS
    ? null
    : {
        code: SeedIntegrityIssueCode.ContentCreatedAtOnce,
        count: times.length,
        message: `${times.length} document(s) were all created within ${spanDays.toFixed(1)} day(s), expected a spread of at least ${MIN_CREATION_SPAN_DAYS}`,
      };
}

function oneAuthor(
  code: SeedIntegrityIssueCode,
  noun: string,
  authorIds: readonly (string | null)[]
): SeedIntegrityIssue | null {
  const counts = new Map<string, number>();
  for (const id of authorIds) {
    if (id) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  const top = Math.max(0, ...counts.values());
  if (authorIds.length === 0 || top / authorIds.length <= MAX_AUTHOR_SHARE) {
    return null;
  }
  return {
    code,
    count: top,
    message: `one person wrote ${top} of ${authorIds.length} ${noun}, more than ${MAX_AUTHOR_SHARE * 100}%`,
  };
}

function uniformPriority(rows: ContentRealismRows): SeedIntegrityIssue | null {
  const priorities = new Set(
    rows.documents.map((document) => document.priority)
  );
  return rows.documents.length === 0 || priorities.size > 1
    ? null
    : {
        code: SeedIntegrityIssueCode.UniformPriority,
        count: rows.documents.length,
        message: `every document has priority ${[...priorities].join(", ")}`,
      };
}

function projectsWithFewIssues(
  rows: ContentRealismRows
): SeedIntegrityIssue | null {
  const issueCounts = new Map<string, number>();
  for (const document of rows.documents) {
    if (document.subtype === DocumentType.Feature && document.projectId) {
      issueCounts.set(
        document.projectId,
        (issueCounts.get(document.projectId) ?? 0) + 1
      );
    }
  }
  const thin = rows.projects.filter(
    (project) =>
      project.status !== ProjectStatus.Archived &&
      (issueCounts.get(project.id) ?? 0) < MIN_ISSUES_PER_LIVE_PROJECT
  );
  return thin.length === 0
    ? null
    : {
        code: SeedIntegrityIssueCode.ProjectWithFewIssues,
        count: thin.length,
        message: `live project(s) with fewer than ${MIN_ISSUES_PER_LIVE_PROJECT} issues: ${examples(thin.map((project) => `${project.name} (${issueCounts.get(project.id) ?? 0})`))}`,
      };
}

function examples(values: readonly string[]): string {
  const shown = values.slice(0, EXAMPLE_LIMIT).join(", ");
  return values.length > EXAMPLE_LIMIT
    ? `${shown}, and ${values.length - EXAMPLE_LIMIT} more`
    : shown;
}
