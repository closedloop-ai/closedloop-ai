import { Priority } from "@repo/api/src/types/common";
import { DocumentType } from "@repo/api/src/types/document";
import { ProjectStatus } from "@repo/api/src/types/project";
import { describe, expect, it } from "vitest";
import {
  assessContentRealism,
  type ContentRealismRows,
} from "./content-realism";
import { SeedIntegrityIssueCode } from "./seed-integrity";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const OWNER = "owner";

/** The shape the pre-ISS-12135 seed left: one author, one minute, one priority. */
function oldSeedRows(): ContentRealismRows {
  return {
    projects: [
      {
        id: "p1",
        name: "Platform Foundation",
        slug: "platform-foundation",
        status: ProjectStatus.InProgress,
      },
      {
        id: "p2",
        name: "Checkout Redesign",
        slug: "PRO-1",
        status: ProjectStatus.InProgress,
      },
    ],
    documents: [
      ...Array.from({ length: 6 }, (_unused, index) => ({
        projectId: index % 2 === 0 ? "p1" : "p2",
        subtype: DocumentType.Prd,
        createdById: OWNER,
        priority: Priority.Medium,
        createdAt: new Date(NOW.getTime() - index * 1000),
      })),
      {
        projectId: "p1",
        subtype: DocumentType.Feature,
        createdById: OWNER,
        priority: Priority.Medium,
        createdAt: NOW,
      },
    ],
    commentAuthorIds: [OWNER, OWNER, OWNER, "teammate"],
  };
}

function realisticRows(): ContentRealismRows {
  const authors = ["pm", "eng-a", "eng-b", "designer"];
  const priorities = [Priority.Low, Priority.Medium, Priority.High];
  const documents = ["p1", "p2"].flatMap((projectId, projectIndex) =>
    Array.from({ length: 5 }, (_unused, index) => ({
      projectId,
      subtype: index < 2 ? DocumentType.Prd : DocumentType.Feature,
      createdById: authors[(index + projectIndex) % authors.length] ?? "pm",
      priority: priorities[index % priorities.length] ?? Priority.Medium,
      createdAt: new Date(NOW.getTime() - (50 - index * 9) * DAY_MS),
    }))
  );
  return {
    projects: [
      {
        id: "p1",
        name: "Platform Foundation",
        slug: "PRO-1",
        status: ProjectStatus.InProgress,
      },
      {
        id: "p2",
        name: "Checkout Redesign",
        slug: "PRO-2",
        status: ProjectStatus.Completed,
      },
      {
        id: "p3",
        name: "Legacy Importer",
        slug: "PRO-3",
        status: ProjectStatus.Archived,
      },
    ],
    documents,
    commentAuthorIds: ["pm", "eng-a", "eng-b", "designer", OWNER],
  };
}

describe("assessContentRealism", () => {
  it("reports nothing for work spread across the team, the weeks and the priorities", () => {
    expect(assessContentRealism(realisticRows())).toEqual([]);
  });

  it("flags every symptom of the old seed", () => {
    const codes = assessContentRealism(oldSeedRows()).map(
      (issue) => issue.code
    );
    expect(codes).toEqual([
      SeedIntegrityIssueCode.ProjectWithoutSlug,
      SeedIntegrityIssueCode.ContentCreatedAtOnce,
      SeedIntegrityIssueCode.OneDocumentAuthor,
      SeedIntegrityIssueCode.OneCommentAuthor,
      SeedIntegrityIssueCode.UniformPriority,
      SeedIntegrityIssueCode.ProjectWithFewIssues,
    ]);
  });

  it("names the project without a product slug and the thin projects", () => {
    const issues = assessContentRealism(oldSeedRows());
    const slug = issues.find(
      (issue) => issue.code === SeedIntegrityIssueCode.ProjectWithoutSlug
    );
    expect(slug?.message).toContain(
      "Platform Foundation (platform-foundation)"
    );
    const thin = issues.find(
      (issue) => issue.code === SeedIntegrityIssueCode.ProjectWithFewIssues
    );
    expect(thin?.count).toBe(2);
  });

  it("does not hold an archived project to the live issue count", () => {
    const rows = realisticRows();
    expect(
      assessContentRealism(rows).some(
        (issue) => issue.code === SeedIntegrityIssueCode.ProjectWithFewIssues
      )
    ).toBe(false);
    expect(rows.projects.find((project) => project.id === "p3")?.status).toBe(
      ProjectStatus.Archived
    );
  });

  it("allows one author exactly half of the comments, not more", () => {
    const rows = realisticRows();
    expect(
      assessContentRealism({
        ...rows,
        commentAuthorIds: [OWNER, OWNER, "pm", "eng-a"],
      })
    ).toEqual([]);
    expect(
      assessContentRealism({
        ...rows,
        commentAuthorIds: [OWNER, OWNER, OWNER, "pm"],
      }).map((issue) => issue.code)
    ).toEqual([SeedIntegrityIssueCode.OneCommentAuthor]);
  });
});
