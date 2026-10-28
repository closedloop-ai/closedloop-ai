import type { DocumentWithProject } from "@repo/api/src/types/document";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { z } from "zod";
import { createFixtureInstant } from "./fixture-clock";
import { liveAppShellRoutes } from "./live-app-fixtures";
import {
  dana,
  hana,
  marco,
  noFavoritesRoute,
  orgUsersRoute,
  priya,
} from "./org-people-fixtures";

// The live Documents index (`apps/app/.../documents/page.tsx`) reads the
// org's DOC artifacts (`GET /documents?type=DOC`)
// and the workspace's people for the assignee column (`GET /users`).

const fixtureInstant = createFixtureInstant("2026-10-06T00:00:00.000Z");

function doc(
  index: number,
  title: string,
  status: DocumentWithProject["status"],
  assignee: DocumentWithProject["assignee"],
  updatedAt: string
): DocumentWithProject {
  return createMockDocument({
    assignee,
    assigneeId: assignee?.id ?? null,
    createdAt: new Date("2026-08-04T09:00:00.000Z"),
    createdById: dana.id,
    id: `doc-${index}`,
    organizationId: "org_test",
    priority: null,
    slug: `DOC-${100 + index}`,
    sortOrder: index,
    status,
    title,
    type: DocumentType.Doc,
    updatedAt: new Date(fixtureInstant(updatedAt)),
  });
}

export const documentsListFixture: DocumentWithProject[] = [
  doc(
    1,
    "Engineering onboarding guide",
    DocumentStatus.Approved,
    dana,
    "2026-10-06T08:40:00.000Z"
  ),
  doc(
    2,
    "Incident response runbook",
    DocumentStatus.InReview,
    marco,
    "2026-10-05T16:05:00.000Z"
  ),
  doc(
    3,
    "Q4 platform roadmap notes",
    DocumentStatus.Draft,
    priya,
    "2026-10-04T11:20:00.000Z"
  ),
  doc(
    4,
    "Design review checklist",
    DocumentStatus.Approved,
    hana,
    "2026-10-02T14:45:00.000Z"
  ),
  doc(
    5,
    "Agent session cost glossary",
    DocumentStatus.ChangesRequested,
    priya,
    "2026-09-29T10:10:00.000Z"
  ),
  doc(
    6,
    "Release train calendar",
    DocumentStatus.Draft,
    null,
    "2026-09-24T09:30:00.000Z"
  ),
];

/** The reads the live Documents index makes, answered with `documents`. */
export function documentsListRoutes(
  documents: DocumentWithProject[] = documentsListFixture
): FixtureRoute[] {
  let currentDocuments = documents.map((document) => ({ ...document }));
  return [
    ...liveAppShellRoutes,
    orgUsersRoute,
    noFavoritesRoute,
    { method: "GET", path: "/documents", respond: () => currentDocuments },
    {
      method: "PUT",
      path: "/documents/*",
      respond: ({ body, pathname }) => {
        const parsed = statusWriteSchema.safeParse(body);
        if (!parsed.success) {
          return {};
        }
        const id = pathname.slice("/documents/".length);
        const document = currentDocuments.find((item) => item.id === id);
        if (!document) {
          return {};
        }
        const updated = { ...document, status: parsed.data.status };
        currentDocuments = currentDocuments.map((item) =>
          item.id === id ? updated : item
        );
        return updated;
      },
    },
    {
      method: "GET",
      path: "/documents/summary",
      respond: () => ({
        total: currentDocuments.length,
        producedByAgentSessions: 0,
        updatedInWindow: 0,
        neverEdited: 0,
        windowDays: 7,
      }),
    },
    {
      method: "POST",
      path: "/documents/costs",
      respond: () => ({
        artifacts: currentDocuments.map((document) => ({
          artifactId: document.id,
        })),
        sessionCosts: [],
      }),
    },
    {
      method: "POST",
      path: "/artifacts/related-sessions",
      respond: () => ({ results: {} }),
    },
  ];
}

export const documentsListApiRoutes = documentsListRoutes();

const statusWriteSchema = z.object({ status: z.enum(DocumentStatus) });
