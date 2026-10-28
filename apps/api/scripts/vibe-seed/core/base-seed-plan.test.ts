import { Priority } from "@repo/api/src/types/common";
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { describe, expect, it } from "vitest";
import { PROJECT_CATALOG } from "./base-seed-catalog";
import {
  type PlannedDocument,
  planBaseSeedContent,
  type SeedRoster,
} from "./base-seed-plan";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const ROSTER: SeedRoster = {
  admin: "admin",
  pms: ["pm"],
  engineers: ["eng-a", "eng-b", "eng-c"],
  designers: ["designer"],
};

const plan = planBaseSeedContent(ROSTER, NOW);

function topicDocuments(topic: string): PlannedDocument[] {
  return plan.documents.filter((document) => document.topic === topic);
}

function ofSubtype(documents: readonly PlannedDocument[], subtype: string) {
  return documents.filter((document) => document.subtype === subtype);
}

describe("planBaseSeedContent", () => {
  it("files every document of a topic under that topic's one project", () => {
    for (const project of PROJECT_CATALOG) {
      for (const topic of project.topics) {
        const projects = new Set(
          topicDocuments(topic.title).map((document) => document.projectIndex)
        );
        expect(projects).toEqual(new Set([PROJECT_CATALOG.indexOf(project)]));
      }
    }
  });

  it("gives every topic a PRD, a plan and its issues", () => {
    for (const topic of PROJECT_CATALOG.flatMap((project) => project.topics)) {
      const documents = topicDocuments(topic.title);
      expect(ofSubtype(documents, DocumentType.Prd)).toHaveLength(1);
      expect(
        ofSubtype(documents, DocumentType.ImplementationPlan)
      ).toHaveLength(1);
      expect(ofSubtype(documents, DocumentType.Feature)).toHaveLength(
        topic.issues.length
      );
    }
  });

  it("gives every active project at least three issues", () => {
    for (const [index, project] of plan.projects.entries()) {
      const issues = plan.documents.filter(
        (document) =>
          document.projectIndex === index &&
          document.subtype === DocumentType.Feature
      );
      expect(issues.length, project.name).toBeGreaterThanOrEqual(3);
    }
  });

  it("creates a topic's PRD before its plan and its plan before its issues", () => {
    for (const topic of PROJECT_CATALOG.flatMap((project) => project.topics)) {
      const documents = topicDocuments(topic.title);
      const [prd] = ofSubtype(documents, DocumentType.Prd);
      const [planned] = ofSubtype(documents, DocumentType.ImplementationPlan);
      const issues = ofSubtype(documents, DocumentType.Feature);
      expect(prd?.createdAt.getTime()).toBeLessThan(
        planned?.createdAt.getTime() ?? 0
      );
      for (const issue of issues) {
        expect(planned?.createdAt.getTime()).toBeLessThan(
          issue.createdAt.getTime()
        );
      }
    }
  });

  it("dates everything inside the last eight weeks and never in the last half hour", () => {
    const earliest = NOW.getTime() - 8 * 7 * DAY_MS;
    const latest = NOW.getTime() - 30 * 60 * 1000;
    for (const document of plan.documents) {
      expect(document.createdAt.getTime()).toBeGreaterThanOrEqual(earliest);
      expect(document.updatedAt.getTime()).toBeLessThanOrEqual(latest);
      expect(document.updatedAt.getTime()).toBeGreaterThanOrEqual(
        document.createdAt.getTime()
      );
    }
    const createdDays = new Set(
      plan.documents.map((document) =>
        Math.floor(document.createdAt.getTime() / DAY_MS)
      )
    );
    expect(createdDays.size).toBeGreaterThan(20);
  });

  it("touches open work recently and leaves settled work where it landed", () => {
    const updated = new Set(
      plan.projects.map((project) => project.updatedAt.getTime())
    );
    expect(updated.size).toBeGreaterThan(plan.projects.length / 2);
    const shipped = topicDocuments("SAML certificate rotation");
    for (const document of shipped) {
      expect(document.updatedAt.getTime()).toBeLessThan(
        NOW.getTime() - 14 * DAY_MS
      );
    }
  });

  it("derives statuses from the topic's stage rather than alternating them", () => {
    const shipped = topicDocuments("SAML certificate rotation");
    expect(ofSubtype(shipped, DocumentType.Prd)[0]?.status).toBe(
      DocumentStatus.Approved
    );
    expect(ofSubtype(shipped, DocumentType.ImplementationPlan)[0]?.status).toBe(
      DocumentStatus.Executed
    );
    expect(
      ofSubtype(shipped, DocumentType.Feature).map((issue) => issue.status)
    ).toEqual([IssueStatus.Done, IssueStatus.Done, IssueStatus.Done]);

    const building = topicDocuments("Rate limits for the public API");
    expect(ofSubtype(building, DocumentType.Prd)[0]?.status).toBe(
      DocumentStatus.Approved
    );
    expect(
      ofSubtype(building, DocumentType.Feature).map((issue) => issue.status)
    ).toEqual([
      IssueStatus.Done,
      IssueStatus.InProgress,
      IssueStatus.InReview,
      IssueStatus.Todo,
    ]);
  });

  it("ends every status history at the planned status", () => {
    for (const document of plan.documents) {
      expect(document.history.at(-1)).toBe(document.status);
    }
  });

  it("varies priority across the work", () => {
    const priorities = new Set(plan.documents.map((doc) => doc.priority));
    expect(priorities).toEqual(
      new Set([Priority.Low, Priority.Medium, Priority.High, Priority.Urgent])
    );
  });

  it("has PRDs written by product, plans by engineers and design docs by design", () => {
    for (const document of plan.documents) {
      if (document.subtype === DocumentType.Prd) {
        expect(["pm", "admin"]).toContain(document.createdById);
      }
      if (document.subtype === DocumentType.ImplementationPlan) {
        expect(ROSTER.engineers).toContain(document.createdById);
      }
      if (document.title.startsWith("Design: ")) {
        expect(document.createdById).toBe("designer");
      }
    }
  });

  it("gives the signed-in person a small slice, with open issues filed by teammates", () => {
    const mine = plan.documents.filter((doc) => doc.assigneeId === "admin");
    expect(mine.length).toBeGreaterThanOrEqual(5);
    expect(mine.length).toBeLessThan(plan.documents.length / 10);
    const openIssues = mine.filter(
      (doc) =>
        doc.subtype === DocumentType.Feature && doc.status !== IssueStatus.Done
    );
    expect(openIssues.length).toBeGreaterThanOrEqual(2);
    for (const issue of openIssues) {
      expect(issue.createdById).not.toBe("admin");
    }
    expect(ofSubtype(mine, DocumentType.Prd).length).toBeGreaterThanOrEqual(1);
  });

  it("spreads leads and authors across the team", () => {
    const leads = new Set(plan.projects.map((project) => project.leadId));
    expect(leads.size).toBeGreaterThanOrEqual(4);
    const authors = new Set(plan.documents.map((doc) => doc.createdById));
    expect(authors).toEqual(
      new Set(["admin", "pm", "eng-a", "eng-b", "eng-c", "designer"])
    );
  });

  it("falls back to the signed-in person when a role has nobody", () => {
    const solo = planBaseSeedContent(
      { admin: "admin", pms: [], engineers: [], designers: [] },
      NOW
    );
    expect(new Set(solo.documents.map((doc) => doc.assigneeId))).toEqual(
      new Set(["admin"])
    );
  });
});
