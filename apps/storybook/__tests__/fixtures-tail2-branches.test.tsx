import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { DOCS_HELP_NAV_PATH } from "@repo/app/help/lib/web-help-contract";
import {
  createFixtureFetch,
  type FixtureRoute,
} from "@repo/app/shared/storybook/fixture-fetch";
import { useNavigationAdapter } from "@repo/navigation/provider";
import type { Decorator } from "@storybook/react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDocumentDetail } from "../stories/surfaces-v2/fixtures/document-detail-fixtures";
import {
  DocsHelpFetch,
  docsNavFixture,
} from "../stories/surfaces-v2/fixtures/help-fixtures";
import {
  packCatalogFixture,
  packDistributionsFixture,
  packsApiRoutes,
} from "../stories/surfaces-v2/fixtures/packs-fixtures";
import { withLiveRoute } from "../stories/surfaces-v2/live-route";

const ORIGIN = "http://localhost";

async function read(routes: FixtureRoute[], path: string): Promise<unknown> {
  const response = await createFixtureFetch(routes)(`${ORIGIN}${path}`);
  const envelope = (await response.json()) as { data: unknown };
  return envelope.data;
}

describe("packs routes", () => {
  it("answers a known distribution and null for an unknown id", async () => {
    const [first] = packDistributionsFixture;
    expect(await read(packsApiRoutes, `/distributions/${first?.id}`)).toEqual(
      JSON.parse(JSON.stringify(first))
    );
    expect(
      await read(packsApiRoutes, "/distributions/dist_missing")
    ).toBeNull();
  });

  it("answers a known catalog item and null for an unknown id", async () => {
    const [first] = packCatalogFixture;
    expect(await read(packsApiRoutes, `/catalog/${first?.id}`)).toEqual(
      JSON.parse(JSON.stringify(first))
    );
    expect(await read(packsApiRoutes, "/catalog/pk_missing")).toBeNull();
  });
});

describe("buildDocumentDetail", () => {
  const base = {
    assignee: null,
    content: "# Body",
    id: "doc_x",
    slug: "PRD-1",
    status: DocumentStatus.Draft,
    title: "Title",
    type: DocumentType.Prd,
    updatedAt: "2026-10-01T00:00:00.000Z",
  };

  it("leaves assigneeId null when the document has no assignee", () => {
    expect(buildDocumentDetail(base).assigneeId).toBeNull();
  });

  it("leaves projectId null and snapshots no repositories for a project-less document", () => {
    const detail = buildDocumentDetail({ ...base, project: null });
    expect(detail.projectId).toBeNull();
    expect(detail.repositorySnapshot.repositories).toEqual([]);
  });
});

describe("DocsHelpFetch without a global location", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves a relative docs path against http://localhost", async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal("location", undefined);
    render(
      <DocsHelpFetch corpus={{ nav: "ok" }}>
        <span>mounted</span>
      </DocsHelpFetch>
    );
    expect(screen.getByText("mounted")).toBeTruthy();
    expect(globalThis.fetch).not.toBe(realFetch);
    const response = await globalThis.fetch(DOCS_HELP_NAV_PATH);
    expect(await response.json()).toEqual({
      navGroups: JSON.parse(JSON.stringify(docsNavFixture)),
    });
  });
});

describe("withLiveRoute", () => {
  function Probe() {
    const adapter = useNavigationAdapter();
    const params = adapter.useRouteParamsValue();
    return <span>{JSON.stringify(params)}</span>;
  }

  function context(parameters: Record<string, unknown>) {
    return { id: "story-1", parameters } as unknown as Parameters<Decorator>[1];
  }

  it("renders the story untouched when it declares no liveRoute", () => {
    // pins current behavior; looks odd because the story mounts outside any
    // navigation provider, so it cannot read route params
    render(withLiveRoute(() => <span>bare story</span>, context({})));
    expect(screen.getByText("bare story")).toBeTruthy();
  });

  it("mounts the story under the org slug alone when liveRoute has no params", async () => {
    render(
      withLiveRoute(Probe, context({ liveRoute: { path: "/org-test/packs" } }))
    );
    await waitFor(() =>
      expect(screen.getByText('{"orgSlug":"org-test"}')).toBeTruthy()
    );
  });
});
