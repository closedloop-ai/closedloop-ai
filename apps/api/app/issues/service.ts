import type {
  CreateIssueInput,
  FindIssuesOptions,
  IssueWithWorkstream,
  UpdateIssueInput,
} from "@repo/api/src/types/issue";
import { type IssuePriority, type IssueStatus, withDb } from "@repo/database";
import { nanoid } from "nanoid";
import { issueIncludeWithContext } from "./issue-utils";

export const issuesService = {
  async findAll(
    options: FindIssuesOptions & { organizationId: string }
  ): Promise<IssueWithWorkstream[]> {
    const {
      organizationId,
      workstreamId,
      projectId,
      status,
      priority,
      assigneeId,
    } = options;

    const issues = await withDb((db) =>
      db.issue.findMany({
        where: {
          organizationId,
          ...(workstreamId ? { workstreamId } : {}),
          ...(!workstreamId && projectId ? { projectId } : {}),
          ...(status ? { status } : {}),
          ...(priority ? { priority } : {}),
          ...(assigneeId ? { assigneeId } : {}),
        },
        include: issueIncludeWithContext,
        orderBy: { createdAt: "desc" },
      })
    );

    return issues.map(toIssueWithWorkstream);
  },

  async findById(
    id: string,
    organizationId: string
  ): Promise<IssueWithWorkstream | null> {
    const issue = await withDb((db) =>
      db.issue.findFirst({
        where: { id, organizationId },
        include: issueIncludeWithContext,
      })
    );

    if (!issue) {
      return null;
    }

    return toIssueWithWorkstream(issue);
  },

  async findBySlug(
    slug: string,
    organizationId: string
  ): Promise<IssueWithWorkstream | null> {
    const issue = await withDb((db) =>
      db.issue.findUnique({
        where: { organizationId_slug: { organizationId, slug } },
        include: issueIncludeWithContext,
      })
    );

    if (!issue) {
      return null;
    }

    return toIssueWithWorkstream(issue);
  },

  async create(
    organizationId: string,
    userId: string,
    input: CreateIssueInput
  ): Promise<IssueWithWorkstream> {
    const issue = await withDb((db) =>
      db.issue.create({
        data: {
          ...input,
          organizationId,
          slug: nanoid(14),
          createdById: userId,
        },
        include: issueIncludeWithContext,
      })
    );

    return toIssueWithWorkstream(issue);
  },

  async update(
    id: string,
    organizationId: string,
    input: Omit<UpdateIssueInput, "id">
  ): Promise<IssueWithWorkstream> {
    const issue = await withDb((db) =>
      db.issue.update({
        where: { id, organizationId },
        data: input,
        include: issueIncludeWithContext,
      })
    );

    return toIssueWithWorkstream(issue);
  },

  async delete(id: string, organizationId: string): Promise<void> {
    await withDb.tx(async (tx) => {
      await tx.entityLink.deleteMany({
        where: {
          OR: [
            { sourceId: id, sourceType: "ISSUE" },
            { targetId: id, targetType: "ISSUE" },
          ],
        },
      });
      await tx.issue.delete({ where: { id, organizationId } });
    });
  },
};

// Type for raw Prisma result before transformation
type RawIssueWithContext = {
  id: string;
  organizationId: string;
  workstreamId: string | null;
  projectId: string | null;
  title: string;
  slug: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeId: string | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  workstream: { id: string; title: string; state: string } | null;
  project: {
    id: string;
    organizationId: string;
    name: string;
    teams: { team: { id: string; name: string } }[];
  } | null;
  assignee: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
  } | null;
  createdBy: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
  };
};

function toIssueWithWorkstream(raw: RawIssueWithContext): IssueWithWorkstream {
  return {
    ...raw,
    project: raw.project
      ? {
          id: raw.project.id,
          name: raw.project.name,
          teams: raw.project.teams.map((pt) => pt.team),
        }
      : null,
  };
}
