/**
 * Branch tests for the versioned-document fixture routes that the Document
 * Detail, PRD Detail and Implementation Plan Detail stories register in their
 * `appCore` parameters. Each route is exercised through the story's own
 * parameters, calling its `respond` the way the fixture transport does.
 */
import type {
  FixtureRequestContext,
  FixtureRoute,
} from "@repo/app/shared/storybook/fixture-fetch";
import { describe, expect, it } from "vitest";
import documentDetailMeta, {
  HistoricalVersion as documentHistorical,
} from "../stories/surfaces/document-detail.stories";
import planDetailMeta from "../stories/surfaces/implementation-plan-detail.stories";
import prdDetailMeta, {
  HistoricalVersion as prdHistorical,
} from "../stories/surfaces/prd-detail.stories";

type AppCoreParams = { apiRoutes: FixtureRoute[] };

type VersionedDocument = {
  id: string;
  slug: string;
  latestVersion: number;
  latestVersionContent?: string;
  version: { content: string; id: string; version: number };
};

const NEW_CONTENT = "# Rewritten";

function contextFor(
  overrides: Partial<FixtureRequestContext>
): FixtureRequestContext {
  return {
    pathname: "",
    search: "",
    searchParams: new URLSearchParams(),
    method: "POST",
    body: undefined,
    ...overrides,
  };
}

function findRoute(params: AppCoreParams, method: string, path: string) {
  const route = params.apiRoutes.find(
    (candidate) => candidate.method === method && candidate.path === path
  );
  if (!route) {
    throw new Error(`no ${method} ${path} route registered`);
  }
  return route;
}

const SURFACES = [
  {
    name: "document detail",
    params: documentDetailMeta.parameters.appCore as AppCoreParams,
    document: documentDetailMeta.args.document as VersionedDocument,
  },
  {
    name: "PRD detail",
    params: prdDetailMeta.parameters.appCore as AppCoreParams,
    document: prdDetailMeta.args.document as VersionedDocument,
  },
  {
    name: "implementation plan detail",
    params: planDetailMeta.parameters.appCore as AppCoreParams,
    document: planDetailMeta.args.document as VersionedDocument,
  },
];

describe.each(SURFACES)(
  "$name POST versions fixture route",
  ({ params, document }) => {
    const route = findRoute(
      params,
      "POST",
      `/documents/${document.id}/versions`
    );
    const nextVersion = document.latestVersion + 1;

    it("saves the posted content as the next version", async () => {
      const saved = (await route.respond(
        contextFor({ body: { content: NEW_CONTENT } })
      )) as VersionedDocument;

      expect(saved.latestVersion).toBe(nextVersion);
      expect(saved.latestVersionContent).toBe(NEW_CONTENT);
      expect(saved.version).toMatchObject({
        content: NEW_CONTENT,
        id: `${document.id}-v${nextVersion}`,
        version: nextVersion,
      });
    });

    it("keeps the current content when the request has no body", async () => {
      const saved = (await route.respond(
        contextFor({ body: undefined })
      )) as VersionedDocument;

      expect(saved.latestVersion).toBe(nextVersion);
      expect(saved.latestVersionContent).toBe(document.latestVersionContent);
      expect(saved.version.content).toBe(document.version.content);
    });

    it("keeps the current content when the body omits content", async () => {
      const saved = (await route.respond(
        contextFor({ body: {} })
      )) as VersionedDocument;

      expect(saved.latestVersionContent).toBe(document.latestVersionContent);
      expect(saved.version.content).toBe(document.version.content);
    });
  }
);

describe.each([
  { name: "document detail", story: documentHistorical },
  { name: "PRD detail", story: prdHistorical },
])("$name by-slug fixture route with version history", ({ story }) => {
  const historical = story.args?.document as VersionedDocument;
  const params = story.parameters?.appCore as AppCoreParams;
  const route = findRoute(
    params,
    "GET",
    `/documents/by-slug/${historical.slug}`
  );

  function read(search: string) {
    return route.respond(
      contextFor({
        method: "GET",
        searchParams: new URLSearchParams(search),
      })
    ) as VersionedDocument;
  }

  it("serves the requested historical version", () => {
    expect(read("version=1").version.version).toBe(1);
  });

  it("serves the latest version when the query has no version", () => {
    expect(read("").version.version).toBe(historical.latestVersion);
  });

  it("falls back to the base document for a version the fixture lacks", () => {
    expect(read("version=99")).toBe(historical);
  });
});
