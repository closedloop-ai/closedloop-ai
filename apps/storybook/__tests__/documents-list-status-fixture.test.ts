import { DocumentStatus } from "@repo/api/src/types/document";
import {
  createFixtureFetch,
  type FixtureRoute,
} from "@repo/app/shared/storybook/fixture-fetch";
import { describe, expect, it } from "vitest";
import {
  documentsListFixture,
  documentsListRoutes,
} from "../stories/surfaces-v2/fixtures/documents-list-fixtures";
import {
  Live,
  LiveNarrow,
} from "../stories/surfaces-v2/v2-documents-list.stories";

const ORIGIN = "http://localhost";

describe("AC-027 Documents list story status fixtures", () => {
  it("persists a selected status in both current stories without sharing their writes", async () => {
    const wideRoutes = storyRoutes(Live.parameters?.appCore?.apiRoutes);
    const narrowRoutes = storyRoutes(LiveNarrow.parameters?.appCore?.apiRoutes);
    const [first, second] = documentsListFixture;
    if (!(first && second)) {
      throw new Error("Documents list fixture needs two rows");
    }

    expect(statusOf(await readDocuments(wideRoutes), first.id)).toBe(
      first.status
    );
    expect(statusOf(await readDocuments(narrowRoutes), first.id)).toBe(
      first.status
    );

    const wideWrite = await writeStatus(
      wideRoutes,
      first.id,
      DocumentStatus.Draft
    );
    expect(wideWrite).toMatchObject({
      id: first.id,
      status: DocumentStatus.Draft,
    });
    expect(statusOf(await readDocuments(wideRoutes), first.id)).toBe(
      DocumentStatus.Draft
    );
    expect(statusOf(await readDocuments(wideRoutes), second.id)).toBe(
      second.status
    );
    expect(statusOf(await readDocuments(narrowRoutes), first.id)).toBe(
      first.status
    );

    const narrowWrite = await writeStatus(
      narrowRoutes,
      first.id,
      DocumentStatus.InReview
    );
    expect(narrowWrite).toMatchObject({
      id: first.id,
      status: DocumentStatus.InReview,
    });
    expect(statusOf(await readDocuments(narrowRoutes), first.id)).toBe(
      DocumentStatus.InReview
    );
    expect(statusOf(await readDocuments(wideRoutes), first.id)).toBe(
      DocumentStatus.Draft
    );
  });

  it("does not persist an invalid status or update an unrelated document", async () => {
    const routes = documentsListRoutes();
    const [first, second] = documentsListFixture;
    if (!(first && second)) {
      throw new Error("Documents list fixture needs two rows");
    }

    expect(
      await writeStatus(routes, first.id, "not-a-document-status")
    ).toEqual({});
    expect(statusOf(await readDocuments(routes), first.id)).toBe(first.status);
    expect(statusOf(await readDocuments(routes), second.id)).toBe(
      second.status
    );
  });
});

function storyRoutes(value: unknown): FixtureRoute[] {
  if (!Array.isArray(value)) {
    throw new Error("Documents story has no fixture routes");
  }
  return value as FixtureRoute[];
}

async function readDocuments(
  routes: FixtureRoute[]
): Promise<Array<{ id: string; status: DocumentStatus }>> {
  const response = await createFixtureFetch(routes)(`${ORIGIN}/documents`);
  const envelope = (await response.json()) as {
    data: Array<{ id: string; status: DocumentStatus }>;
  };
  return envelope.data;
}

async function writeStatus(
  routes: FixtureRoute[],
  id: string,
  status: string
): Promise<unknown> {
  const response = await createFixtureFetch(routes)(
    `${ORIGIN}/documents/${id}`,
    { method: "PUT", body: JSON.stringify({ status }) }
  );
  const envelope = (await response.json()) as { data: unknown };
  return envelope.data;
}

function statusOf(
  documents: Array<{ id: string; status: DocumentStatus }>,
  id: string
): DocumentStatus | undefined {
  return documents.find((document) => document.id === id)?.status;
}
